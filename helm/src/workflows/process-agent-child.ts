import { join } from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Convert } from "typebox/value";
import { throwIfProviderLimit } from "./agent.js";
import { compactAgentHistory } from "./agent-history.js";
import { resolveModelSpecWithThinking } from "./model-spec.js";

interface ToolDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

interface AgentInit {
  type: "init";
  nonce: string;
  prompt: string;
  cwd: string;
  label?: string;
  instructions?: string;
  model?: string;
  thinkingLevel?: string;
  schema?: Record<string, unknown>;
  maxSchemaRetries?: number;
  tools: ToolDescriptor[];
}

interface ToolResponse {
  type: "tool-response";
  nonce: string;
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { message: string };
}

let nonce: string | undefined;
let nextId = 1;
let activeSession: { abort(): Promise<void> } | undefined;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

process.on("message", (message: AgentInit | ToolResponse | { type: "abort"; nonce: string }) => {
  if (message.type === "abort" && message.nonce === nonce) void activeSession?.abort();
  if (message.type === "tool-response") {
    if (message.nonce !== nonce) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error?.message ?? "Parent tool execution failed"));
    return;
  }
  if (message.type === "init" && !nonce) void run(message);
});

async function run(init: AgentInit): Promise<void> {
  nonce = init.nonce;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let outcome: {
    type: "result";
    nonce: string;
    ok: boolean;
    value?: unknown;
    error?: ReturnType<typeof serializeError>;
  };
  let structuredValue: unknown;
  let structuredCalled = false;
  const tools = init.tools.map((descriptor) => proxyTool(init, descriptor));
  if (init.schema) {
    const schema = Type.Unsafe(init.schema);
    tools.push({
      name: "structured_output",
      label: "Structured Output",
      description: "Return the final result matching the required schema",
      parameters: schema,
      async execute(_id, input) {
        const converted = Convert(schema, input);
        if (!Check(schema, converted)) throw new Error("structured_output did not match the required schema");
        structuredCalled = true;
        structuredValue = converted;
        return { content: [{ type: "text", text: "Structured output accepted" }], details: {}, terminate: true };
      },
    } as ToolDefinition);
  }

  try {
    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const registry = new ModelRegistry(modelRuntime);
    const settingsManager = SettingsManager.create(init.cwd, agentDir);
    // Do not execute ambient extensions in the child. Every executable tool is an
    // explicit parent proxy; skills, prompts, and context files remain available.
    const resourceLoader = new DefaultResourceLoader({
      cwd: init.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
    });
    await resourceLoader.reload();
    const resolved = init.model ? resolveModelSpecWithThinking(init.model, registry) : undefined;
    if (init.model && !resolved?.model) {
      process.send?.({ type: "model-fallback", nonce: init.nonce, model: init.model });
    }
    ({ session } = await createAgentSession({
      cwd: init.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(init.cwd),
      settingsManager,
      resourceLoader,
      customTools: tools,
      tools: tools.map((tool) => tool.name),
      modelRuntime,
      ...(resolved?.model ? { model: resolved.model } : {}),
      ...(resolved?.thinkingLevel
        ? { thinkingLevel: resolved.thinkingLevel }
        : init.thinkingLevel
          ? { thinkingLevel: init.thinkingLevel as never }
          : {}),
    }));
    activeSession = session;
    const actualModel = session.model ? `${session.model.provider}/${session.model.id}` : undefined;
    if (actualModel) {
      process.send?.({ type: "model", nonce: init.nonce, model: resolved?.resolvedSpec ?? actualModel });
    }

    const prompt = [
      init.instructions,
      init.label ? `Task label: ${init.label}` : undefined,
      init.prompt,
      init.schema
        ? "Final output contract: call structured_output as your final action with the required fields."
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    await session.prompt(prompt);
    throwIfProviderLimit(session.messages, init.label);

    if (init.schema && !structuredCalled) {
      try {
        session.setActiveToolsByName(["structured_output"]);
      } catch {
        // The repair prompt remains useful if the host cannot narrow active tools.
      }
      const retries = Math.max(0, Math.min(5, init.maxSchemaRetries ?? 2));
      for (let attempt = 0; attempt < retries && !structuredCalled; attempt++) {
        await session.prompt(
          "You did not call structured_output. Call structured_output now as your only action with the required fields.",
        );
        throwIfProviderLimit(session.messages, init.label);
      }
    }

    const result = init.schema
      ? structuredCalled
        ? structuredValue
        : extractStructured(session.messages, init.schema)
      : lastText(session.messages);
    if (result === undefined || (typeof result === "string" && !result.trim())) {
      throw new Error(
        init.schema ? "Subagent did not produce valid structured_output" : "Subagent produced no assistant output",
      );
    }
    outcome = { type: "result", nonce: init.nonce, ok: true, value: result };
  } catch (error) {
    outcome = { type: "result", nonce: init.nonce, ok: false, error: serializeError(error) };
  } finally {
    if (session) {
      try {
        const stats = session.getSessionStats();
        process.send?.({ type: "usage", nonce: init.nonce, usage: { ...stats.tokens, cost: stats.cost } });
        process.send?.({ type: "history", nonce: init.nonce, history: compactAgentHistory(session.messages) });
      } catch {
        // Diagnostics must not mask the agent result.
      }
      session.dispose();
    }
    activeSession = undefined;
  }
  // IPC preserves send order: diagnostics must be queued before the terminal result,
  // because the parent tears down the child as soon as it receives that result.
  process.send?.(outcome);
}

function proxyTool(init: AgentInit, descriptor: ToolDescriptor): ToolDefinition {
  return {
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    parameters: Type.Unsafe(descriptor.parameters),
    promptSnippet: descriptor.promptSnippet,
    promptGuidelines: descriptor.promptGuidelines,
    async execute(toolCallId, input, signal, onUpdate) {
      if (signal?.aborted) throw new Error("Tool execution aborted");
      const id = nextId++;
      const abort = () => process.send?.({ type: "tool-abort", nonce: init.nonce, id });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return (await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          process.send?.({ type: "tool-request", nonce: init.nonce, id, toolCallId, toolName: descriptor.name, input });
        })) as never;
      } finally {
        signal?.removeEventListener("abort", abort);
        onUpdate?.({ content: [{ type: "text", text: "Parent tool execution completed" }], details: {} });
      }
    },
  } as ToolDefinition;
}

function lastText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function extractStructured(messages: unknown[], rawSchema: Record<string, unknown>): unknown {
  const text = lastText(messages);
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? text.match(/([[{][\s\S]*[\]}])/);
  if (!match?.[1]) return undefined;
  try {
    const schema = Type.Unsafe(rawSchema);
    const converted = Convert(schema, JSON.parse(match[1]));
    return Check(schema, converted) ? converted : undefined;
  } catch {
    return undefined;
  }
}

function serializeError(error: unknown): { message: string; name?: string; code?: string; recoverable?: boolean } {
  if (!(error instanceof Error)) return { message: String(error) };
  const value = error as Error & { code?: string; recoverable?: boolean };
  return { message: value.message, name: value.name, code: value.code, recoverable: value.recoverable };
}

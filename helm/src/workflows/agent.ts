import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import { streamSimple as streamCompat } from "@earendil-works/pi-ai/compat";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import {
  formatTierFallbackNotice,
  loadModelTierConfig,
  type ModelTierConfig,
  type RankableModel,
  resolveTierModel,
} from "./model-tier-config.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
  onTierWithoutConfig?: (tier: string) => void,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    // Tier requested but unconfigured → it silently falls back to mainModel.
    // Let the caller surface that (once) so the no-op is discoverable.
    if (!config) onTierWithoutConfig?.(options.tier);
    return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Shared model registry from the host Pi session. When provided, subagents
   * resolve tier/model specs against the same registry the main session uses,
   * including dynamically-registered providers such as ollama-cloud. Standalone
   * runs lazily build an isolated disk-backed runtime only when model routing is
   * requested, so they may miss extension-only providers.
   */
  modelRegistry?: ModelRegistry;
  /**
   * Persist each subagent transcript as a real pi session file under the
   * standard sessions directory (keyed by the runner's project cwd), instead
   * of the default in-memory session that is discarded when the run ends.
   * Default: false (current behavior).
   */
  persistAgentSessions?: boolean;
}

/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built.
 */
export function listAvailableModels(registry?: ModelRegistry): RankableModel[] {
  try {
    if (!registry) return [];
    return registry.getAvailable().map((model) => ({
      spec: canonicalModelSpec(model),
      costOutput: model.cost?.output,
      contextWindow: model.contextWindow,
    }));
  } catch {
    return [];
  }
}

/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry?: ModelRegistry): string[] {
  return listAvailableModels(registry).map((model) => model.spec);
}

/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel: string | undefined, registry: ModelRegistry): void {
  if (warnedTierUnconfigured) return;
  warnedTierUnconfigured = true;
  try {
    console.warn(formatTierFallbackNotice(mainModel, listAvailableModels(registry)));
  } catch {
    // best-effort diagnostic
  }
}

/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir: string): void {
  if (warnedPersistSecrets) return;
  warnedPersistSecrets = true;
  console.warn(
    `[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`,
  );
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats: {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}): AgentUsage | undefined {
  const { tokens, cost } = stats;
  if (tokens.total <= 0 && cost <= 0) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    total: tokens.total,
    cost,
  };
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  /**
   * Display name recorded on the persisted session (session_info entry) when
   * `persistAgentSessions` is enabled, so transcripts are identifiable in
   * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
   * sessions or when an explicit session.sessionManager override is injected.
   */
  sessionName?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost — but NOT when the provider reported no usage at all
   * (all-zero stats), so consumers keep their scalar fallback.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /** Per-agent thinking effort. Overrides the inherited parent thinking level. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called when `model`/`tier`/phase resolved to a spec that wasn't found (fell back to session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
  /**
   * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
   * `disallowedToolNames`), so they are available even under a restrictive
   * allowlist. Used by the workflow runtime to inject shared-store tools into
   * every agent regardless of its agentType definition.
   */
  systemTools?: ToolDefinition[];
  /**
   * Per-run model registry override. Takes precedence over the constructor's
   * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for model resolution.
   * Falls back to the constructor's shared registry, then a lazily-built disk
   * runtime when the run requests explicit model routing.
   */
  modelRegistry?: ModelRegistry;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

const EMPTY_MODEL_REGISTRY = {
  getAvailable: () => [],
  getAll: () => [],
  find: () => undefined,
} as unknown as ModelRegistry;

async function createLegacyFauxRuntime(model: Model<any> | undefined, agentDir: string): Promise<ModelRuntime | undefined> {
  if (!model?.api.startsWith("faux:")) return undefined;
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  runtime.registerProvider(model.provider, {
    name: model.provider,
    api: model.api,
    apiKey: "faux-test-provider",
    baseUrl: model.baseUrl,
    streamSimple: (candidate, context, options) => streamCompat(candidate, context, options),
    models: [{
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers: model.headers,
      compat: model.compat,
    }],
  });
  return runtime;
}

export class WorkflowAgent {
  /**
   * Appended to a subagent's prompt whenever a schema is in effect, instructing
   * the model to end its turn with a single structured_output tool call rather
   * than a prose answer.
   */
  private static readonly STRUCTURED_OUTPUT_CONTRACT = [
    "Final output contract:",
    "- End the task with exactly one structured_output tool call; its arguments are this subagent's return value.",
    "- Do not emit a prose final answer instead of structured_output.",
    "- Inspect files or run any commands you need first, then call structured_output exactly once as your final action.",
  ].join("\n");

  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly persistAgentSessions: boolean;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Shared registry from the host session, when provided. */
  private readonly sharedRegistry?: ModelRegistry;
  private diskRegistryPromise?: Promise<ModelRegistry>;
  private diskModelRuntime?: ModelRuntime;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.sessionOptions = options.session ?? {};
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.sharedRegistry = options.modelRegistry;
  }

  /**
   * Resolve the registry for a run: an explicit per-run registry wins, then the
   * constructor's shared registry. The empty facade preserves the synchronous
   * seam; routed standalone runs upgrade it through getDiskRegistry().
   */
  private getRegistry(perRunRegistry?: ModelRegistry): ModelRegistry {
    if (perRunRegistry) {
      return perRunRegistry;
    }
    if (this.sharedRegistry) {
      return this.sharedRegistry;
    }
    return EMPTY_MODEL_REGISTRY;
  }

  private getDiskRegistry(): Promise<ModelRegistry> {
    if (!this.diskRegistryPromise) {
      const dir = getAgentDir();
      this.diskRegistryPromise = ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
        allowModelNetwork: false,
      }).then((runtime) => {
        this.diskModelRuntime = runtime;
        return new ModelRegistry(runtime);
      });
    }
    return this.diskRegistryPromise;
  }

  /**
   * Session manager for one subagent run. File-backed (persisted under the
   * standard sessions dir, keyed by the runner's project cwd — never a
   * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
   *
   * SessionManager.create() only creates the session directory — the SDK writes
   * the session file lazily (synchronous fs calls, uncaught) on the first
   * assistant message, deep inside session.prompt(). A failure there would
   * otherwise throw mid-run and abort this subagent. Probe writability up front
   * so any create/write failure (permissions, disk full) degrades this single
   * agent to an in-memory session instead — the run continues, just without a
   * persisted transcript.
   */
  private createSessionManager(): SessionManager {
    if (!this.persistAgentSessions) return SessionManager.inMemory();
    try {
      const manager = SessionManager.create(this.cwd);
      this.assertSessionDirWritable(manager.getSessionDir());
      warnPersistSecretsOnce(manager.getSessionDir());
      return manager;
    } catch (error) {
      console.warn(
        `[workflow] persistAgentSessions: could not persist this agent's session (${
          error instanceof Error ? error.message : String(error)
        }); continuing with an in-memory session`,
      );
      return SessionManager.inMemory();
    }
  }

  /** Best-effort write probe: throws if the session directory isn't actually writable. */
  private assertSessionDirWritable(dir: string): void {
    const probePath = join(dir, `.write-probe-${randomUUID()}`);
    writeFileSync(probePath, "");
    unlinkSync(probePath);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    const runCwd = options.cwd ?? this.cwd;
    const customTools = this.assembleTools(runCwd, options, capture);
    const { model: resolvedModel, thinkingLevel: resolvedThinkingLevel } = await this.resolveRunModel(options);

    const agentDir = getAgentDir();
    const compatibilityRuntime = await createLegacyFauxRuntime(
      this.sessionOptions.model as Model<any> | undefined,
      agentDir,
    );
    // Persisted transcripts are grouped by the runner's project cwd (this.cwd),
    // not the per-call runCwd, so worktree-scoped agents don't scatter their
    // sessions across throwaway worktree paths.
    const sessionManager = this.createSessionManager();
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager,
      // A real SettingsManager reads ~/.pi/settings.json, so the subagent inherits
      // the user's configured default provider/model. The in-memory variant skips
      // that file and would instead select the first available model (e.g.
      // openai-codex), which frequently lacks valid auth and returns empty output.
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...(compatibilityRuntime || this.diskModelRuntime
        ? { modelRuntime: compatibilityRuntime ?? this.diskModelRuntime }
        : {}),
      ...this.sessionOptions,
      // A per-call model/thinking level takes priority over sessionOptions defaults.
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinkingLevel || options.thinkingLevel
        ? { thinkingLevel: resolvedThinkingLevel ?? options.thinkingLevel }
        : {}),
    });

    // Tag the persisted session so it can be recognized in session pickers. Skipped
    // when an injected sessionManager override is in play (tests/embedders).
    if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
      try {
        sessionManager.appendSessionInfo(options.sessionName);
      } catch {
        // Session naming is cosmetic; a failure must never abort the run.
      }
    }

    let detachAbort: (() => void) | undefined;
    let detachHistory: (() => void) | undefined;
    let lastHistoryAt = 0;
    const flushHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const throttledHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryAt < 250) return;
      lastHistoryAt = now;
      flushHistory();
    };
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory) {
        detachHistory = session.subscribe(() => throttledHistory());
      }

      await session.prompt(this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)));

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK does not throw provider usage/quota/rate-limit failures; it records
      // them on the terminal assistant message. Check for that first — ahead of the
      // schema and empty-text branches — so it becomes a recoverable checkpoint
      // instead of a SCHEMA_NONCOMPLIANCE error or a silently-null empty output.
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (messages) =>
          this.lastAssistantText(messages),
        )) as AgentRunResult<TSchemaDef>;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      detachAbort?.();
      detachHistory?.();
      try {
        flushHistory();
      } catch {
        // A final history emission is diagnostic only and must not hide the outcome.
      }
      if (options.onUsage) {
        try {
          // Usage must be read before dispose() tears down the session state.
          const usage = usageFromStats(session.getSessionStats());
          if (usage) options.onUsage(usage);
        } catch {
          // Usage reporting is best-effort; a stats failure must not hide the outcome.
        }
      }
      session.dispose();
    }
  }

  /**
   * Build the tool set for one run. A per-call cwd gets freshly-constructed coding
   * tools because tools bind their working directory at construction. The agentType
   * allowlist/denylist is applied first; the always-available system tools and the
   * schema's structured_output tool are layered on afterwards so a restrictive
   * policy can never remove them.
   */
  private assembleTools<TSchemaDef extends TSchema | undefined>(
    runCwd: string,
    options: AgentRunOptions<TSchemaDef>,
    capture: StructuredOutputCapture<any>,
  ): ToolDefinition[] {
    const base = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    const tools: ToolDefinition[] = applyToolPolicy(
      [...base, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
    );
    if (options.systemTools?.length) {
      tools.push(...options.systemTools);
    }
    if (options.schema) {
      tools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }
    return tools;
  }

  /**
   * Choose the concrete model (and thinking level) for one run. Precedence is
   * explicit model > tier > default tier, which composes with workflow.ts phase
   * routing since that only sets options.model on a phase match. Specs are parsed
   * Pi-CLI style, honoring an optional :thinking suffix (e.g. gpt-5.5:xhigh); an
   * unresolvable spec logs a warning and leaves the session default in place.
   */
  private async resolveRunModel<TSchemaDef extends TSchema | undefined>(
    options: AgentRunOptions<TSchemaDef>,
  ): Promise<{ model?: Model<any>; thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"] }> {
    let registry = this.getRegistry(options.modelRegistry);
    const spec = resolveAgentModelSpec(options, this.mainModel, loadModelTierConfig, () =>
      warnTierUnconfiguredOnce(this.mainModel, registry),
    );
    if (!spec) return {};
    if (registry === EMPTY_MODEL_REGISTRY) registry = await this.getDiskRegistry();

    const resolved = resolveModelSpecWithThinking(spec, registry);
    if (resolved.warning) console.warn(`[workflow] ${resolved.warning}`);
    if (!resolved.model) {
      console.warn(`[workflow] model "${spec}" not found; using session default`);
      options.onModelFallback?.(spec);
      return {};
    }
    options.onModelResolved?.(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model));
    return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const segments: string[] = [];
    const append = (segment: string | undefined) => {
      if (segment) segments.push(segment);
    };

    append(this.instructions);
    append(options.instructions);
    if (options.label) append(`Task label: ${options.label}`);
    append(prompt);
    if (structured) append(WorkflowAgent.STRUCTURED_OUTPUT_CONTRACT);

    return segments.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const combined = message.content.reduce(
        (acc, part) => (part.type === "text" ? acc + (part as TextContent).text : acc),
        "",
      );
      if (combined.trim()) return combined;
    }
    return "";
  }
}

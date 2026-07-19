/**
 * Shared test doubles for the Pi ExtensionAPI surface that command-registration
 * code touches (getCommands / registerCommand) plus a notify-capturing command
 * context. Centralising these removes the copy-pasted `pi: any` mocks and the
 * per-test `as never` casts across the command test files.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mock } from "node:test";

export interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
}

export interface CommandRegistryPi {
  /** Typed as ExtensionAPI for call sites; backed by the in-memory registry. */
  pi: ExtensionAPI;
  /** Commands registered so far (most code registers, then we inspect/invoke). */
  commands: RegisteredCommand[];
  /** Messages delivered via pi.sendMessage, captured for assertions. */
  sent: Array<{ customType?: string; content?: string; display?: boolean }>;
  activeTools: string[];
  registeredTools: unknown[];
}

/**
 * A Pi mock that records registered commands and sent messages.
 *
 * @param existing - command names to pretend are already registered, so
 *   idempotency guards (isRegistered) can be exercised.
 */
export function makeCommandRegistryPi(existing: string[] = [], initialTools: string[] = []): CommandRegistryPi {
  const commands: RegisteredCommand[] = [];
  const sent: Array<{ customType?: string; content?: string; display?: boolean }> = [];
  const names = () => [...existing, ...commands.map((c) => c.name)];
  const activeTools = [...initialTools];
  const registeredTools: unknown[] = [];

  const pi = {
    getCommands: () => names().map((name) => ({ name })),
    registerCommand: (name: string, spec: Omit<RegisteredCommand, "name">) => {
      commands.push({ name, ...spec });
    },
    sendMessage: (msg: { customType?: string; content?: string; display?: boolean }) => {
      sent.push(msg);
    },
    registerTool: (tool: unknown) => registeredTools.push(tool),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
    on: () => {},
    reload: async () => {},
  } as unknown as ExtensionAPI;

  return { pi, commands, sent, activeTools, registeredTools };
}

export interface NotifyCtx {
  ctx: ExtensionCommandContext;
  notified: Array<{ message: string; type?: string }>;
}

/** A command context that captures ui.notify calls and no-ops the rest. */
export function makeNotifyCtx(): NotifyCtx {
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: () => {},
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notified };
}

/** Pi double used by task-panel tests that expose captured delivery calls inline. */
export function makeMessagePi(): ExtensionAPI & { _calls: Array<{ content: string; customType?: string }> } {
  const calls: Array<{ content: string; customType?: string }> = [];
  return {
    sendMessage(message: unknown) {
      const value = message as { content?: string; customType?: string };
      calls.push({ content: value.content ?? "", customType: value.customType });
    },
    registerTool: () => {},
    on: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
    reload: async () => {},
    _calls: calls,
  } as unknown as ExtensionAPI & { _calls: Array<{ content: string; customType?: string }> };
}

export interface EventPi {
  on: ReturnType<typeof mock.fn>;
  getActiveTools: ReturnType<typeof mock.fn>;
  setActiveTools: ReturnType<typeof mock.fn>;
  handlers: Record<string, Array<(...args: any[]) => any>>;
}

export function makeEventPi(initialTools: string[] = []): EventPi {
  const handlers: EventPi["handlers"] = {};
  return {
    on: mock.fn((event: string, handler: (...args: any[]) => any) => {
      (handlers[event] ??= []).push(handler);
    }),
    getActiveTools: mock.fn(() => [...initialTools]),
    setActiveTools: mock.fn(),
    handlers,
  };
}

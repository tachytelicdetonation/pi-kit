import assert from "node:assert/strict";
import test from "node:test";
import type { HelmApp } from "../../src/app.js";
import type { DataSource } from "../../src/data/source.js";
import { fakeTui, theme256, withTempProject } from "../conformance-v2/helpers.js";

type Handler = (event: unknown, context: unknown) => unknown;
type Command = { handler(args: string, context: unknown): Promise<void> };

test("H2: a render exception releases the full-screen command and restores the host usage footer", async () => {
  await withTempProject(async (root) => {
    const oldCwd = process.cwd();
    const oldHome = process.env.HOME;
    process.chdir(root);
    process.env.HOME = root;
    try {
      const handlers = new Map<string, Handler[]>();
      const commands = new Map<string, Command>();
      const pi = {
        on(name: string, handler: Handler) {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerCommand(name: string, command: Command) {
          commands.set(name, command);
        },
        registerTool() {},
        getCommands: () => [],
        getActiveTools: () => [],
        setActiveTools() {},
        getThinkingLevel: () => "off",
        exec: async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
        sendMessage() {},
        sendUserMessage() {},
      };

      const { default: registerHelm } = await import("../../extensions/helm.js");
      registerHelm(pi as never);

      const footerCalls: unknown[] = [];
      let renderReached = false;
      const context = {
        mode: "tui",
        cwd: root,
        hasUI: true,
        model: undefined,
        sessionManager: {
          getEntries: () => [],
          getSessionId: () => "render-cleanup-session",
        },
        getContextUsage: () => undefined,
        ui: {
          setFooter(factory: unknown) { footerCalls.push(factory); },
          notify() {},
          setStatus() {},
          async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => HelmApp) {
            const component = factory(fakeTui(), theme256, {}, () => {});
            const original = (component as unknown as { dataSource: DataSource }).dataSource;
            (component as unknown as { dataSource: DataSource }).dataSource = new Proxy(original, {
              get(target, property, receiver) {
                if (property === "snapshot") return () => {
                  renderReached = true;
                  throw new Error("injected render failure");
                };
                return Reflect.get(target, property, receiver);
              },
            });
            try {
              component.render(100);
            } finally {
              component.dispose();
            }
          },
        },
      };

      const starts = handlers.get("session_start") ?? [];
      assert.ok(starts.length >= 2, "extension and usage footer session hooks are registered");
      await starts[0]?.({}, context);
      await starts[1]?.({}, context);
      const usageFooter = footerCalls.at(-1);
      assert.ok(usageFooter, "the normal host usage footer is installed before Helm opens");

      const helm = commands.get("helm");
      assert.ok(helm, "/helm command is registered");
      await assert.rejects(
        () => helm.handler("", context),
        /injected render failure/,
        "the renderer failure is allowed to terminate the custom full-screen call",
      );

      assert.equal(renderReached, true, "failure came from HelmApp's real render path");
      assert.notEqual(footerCalls.at(-2), usageFooter, "opening Helm suspended the host footer");
      assert.equal(footerCalls.at(-1), usageFooter, "the same usage footer is restored after render failure");
      assert.ok(!footerCalls.includes(undefined), "cleanup never leaks back to the host's built-in footer/ANSI region");
    } finally {
      process.chdir(oldCwd);
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HelmApp } from "../src/app.js";
import type { DataSource } from "../src/data/source.js";
import { createWorkflowPort, createUsagePort } from "../src/host/adapters.js";
import { probeCapabilities, resetCapabilities } from "../src/host/capabilities.js";
import { createHelmDataSource } from "../src/host/composition.js";
import { FooterController } from "../src/host/footer-controller.js";
import type { HelmPresence } from "../src/host/presence.js";
import { registerClaudeCmux } from "../src/cmux/register.js";
import { registerCodexSearch } from "../src/search/register.js";
import { registerUsageHealth } from "../src/usage/register.js";
import { registerWorkflows } from "../src/workflows/register.js";

export default function helmExtension(pi: ExtensionAPI) {
  const uiRef: { ui?: { setFooter(f: unknown): void } } = {};
  const state: { open: boolean; ds?: DataSource } = { open: false };
  const presence: HelmPresence = { isOpen: () => state.open, dataSource: () => state.ds };
  const footer = new FooterController({ setFooter: (f) => uiRef.ui?.setFooter(f) });

  // MUST be registered before registerUsageHealth so uiRef is set when its
  // session_start handler installs the usage footer through the controller.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    uiRef.ui = ctx.ui;
    // Probe once per session; degradation is structural (absent backends just yield empty lanes).
    void probeCapabilities({
      exec: async (cmd, args) => {
        const r = await pi.exec(cmd, [...(args ?? [])], { timeout: 10_000 });
        if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}`);
        return r;
      },
      workflowHost: Boolean(
        (pi as any).getWorkflowHostCapabilities?.()?.executableActiveToolDefinitions &&
        (pi as any).getWorkflowHostCapabilities?.()?.cwdAwareBuiltinDefinitions,
      ),
    }).catch(() => {});
  });
  pi.on("session_shutdown", async () => { resetCapabilities(); });

  const usage = registerUsageHealth(pi, { footer });
  const workflows = registerWorkflows(pi, { presence });
  const cmux = registerClaudeCmux(pi, { presence });
  registerCodexSearch(pi);

  const ds = createHelmDataSource({
    workflows: createWorkflowPort(workflows.manager, cmux.getManager),
    usage: createUsagePort(usage),
  });
  state.ds = ds;

  pi.registerCommand("helm", {
    description: "Open helm — the full-screen mission-control view",
    handler: async (_args, ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("helm is only available in the interactive TUI", "warning"); return; }
      uiRef.ui = ctx.ui;
      const onBell = () => { try { process.stdout.write("\x07"); } catch { /* seam: host bell API */ } };
      state.open = true;
      footer.suspendForFullScreen();
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new HelmApp(tui, theme, done, ds, onBell));
      } finally {
        state.open = false;
        footer.restore();
      }
    },
  });
}

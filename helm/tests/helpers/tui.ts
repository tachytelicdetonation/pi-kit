import type { TuiLike } from "../../src/app.js";

/** Remove SGR styling from rendered terminal text. */
export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

export function fakeTui(rows = 40, columns = 120): TuiLike {
  return { terminal: { rows, columns }, requestRender() {} };
}

export function trackedTui(rows = 40, columns = 120): { tui: TuiLike; renders: () => number } {
  let count = 0;
  return {
    tui: { terminal: { rows, columns }, requestRender() { count += 1; } },
    renders: () => count,
  };
}

/** Let pending promise continuations and event handlers run. */
export async function flush(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export const theme256 = { getColorMode: () => "256color" as const };

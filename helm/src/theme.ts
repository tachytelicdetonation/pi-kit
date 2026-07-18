/**
 * Design tokens for helm's full-screen mission-control UI.
 *
 * Color is emitted as raw truecolor ANSI (with a 256-color fallback), following
 * the palette from the stage-4 design handoff rather than the host theme's named
 * roles — the mocks specify exact hex values per screen. Only a color-mode probe
 * is needed from the host theme; see {@link ThemeLike}.
 */

/**
 * Structural subset of the host Theme we depend on. Only the color-mode probe is
 * used: when it reports "256color" we emit the xterm-256 fallback code instead
 * of truecolor.
 */
export interface ThemeLike {
  getColorMode?(): "truecolor" | "256color";
}

/** A palette color: exact truecolor plus a reasonable xterm-256 fallback. */
export interface PaletteColor {
  rgb: [number, number, number];
  xterm: number;
}

/**
 * Emit `text` wrapped in a truecolor (or 256-color fallback) foreground code.
 * Returns "" for empty text so callers can compose unconditionally without
 * emitting stray reset sequences.
 */
export function paint(theme: ThemeLike, color: PaletteColor, text: string): string {
  if (!text) return "";
  if (theme.getColorMode?.() === "256color") return `\x1b[38;5;${color.xterm}m${text}\x1b[39m`;
  const [red, green, blue] = color.rgb;
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}

/**
 * Every design token from the handoff, each a truecolor value plus a sensible
 * xterm-256 fallback. Grouped by role in comments; a flat object so call sites
 * read as `PALETTE.primary` etc.
 */
export const PALETTE = {
  // Surfaces
  bg: { rgb: [23, 24, 28], xterm: 234 }, // #17181c background
  divider: { rgb: [38, 40, 47], xterm: 236 }, // #26282f panel dividers
  inputBorder: { rgb: [74, 66, 88], xterm: 60 }, // #4a4258 input-box border

  // Text tiers
  bright: { rgb: [230, 233, 239], xterm: 254 }, // #e6e9ef
  primary: { rgb: [212, 216, 224], xterm: 252 }, // #d4d8e0
  label: { rgb: [174, 180, 192], xterm: 249 }, // #aeb4c0
  mid: { rgb: [141, 147, 161], xterm: 246 }, // #8d93a1
  dim: { rgb: [107, 114, 128], xterm: 242 }, // #6b7280
  faint: { rgb: [77, 81, 88], xterm: 239 }, // #4d5158
  ghost: { rgb: [61, 64, 72], xterm: 238 }, // #3d4048

  // Providers
  codex: { rgb: [76, 157, 240], xterm: 75 }, // #4c9df0 blue
  claude: { rgb: [240, 149, 76], xterm: 209 }, // #f0954c orange
  kimi: { rgb: [45, 212, 191], xterm: 43 }, // #2dd4bf teal

  // Semantic
  success: { rgb: [62, 207, 110], xterm: 78 }, // #3ecf6e
  error: { rgb: [240, 92, 92], xterm: 203 }, // #f05c5c
  warning: { rgb: [232, 195, 90], xterm: 179 }, // #e8c35a
  purple: { rgb: [167, 139, 250], xterm: 141 }, // #a78bfa model tag
  brand: { rgb: [138, 180, 248], xterm: 111 }, // #8ab4f8 pi
  spent: { rgb: [51, 54, 62], xterm: 237 }, // #33363e spent / empty cells
} satisfies Record<string, PaletteColor>;

/**
 * Glyph vocabulary from the handoff. Named by role so screens never inline the
 * codepoints — a glyph change lands in one place.
 */
export const GLYPH = {
  bar: "▮", // U+25AE bar cell
  tick: "▊", // test tick
  chip: "▪", // pipeline chip
  needsYou: "▲", // needs-you marker
  goal: "◆", // goal
  running: "●", // running
  verifying: "◌", // verifying
  queued: "⏸", // queued
  loops: "∞", // background loops
  parallel: "⣿", // parallel lanes
  collapsed: "▸", // collapsed row
  expanded: "▾", // expanded row
  prompt: "❯", // prompt caret
  treeMid: "├", // tree branch (has siblings below)
  treeEnd: "└", // tree branch (last)
  treeVert: "│", // tree vertical connector
} as const;

/**
 * FooterController — the SINGLE owner of `ctx.ui.setFooter` for helm's lifetime.
 *
 * helm is the one UI panel on top of pi. In the normal REPL the usage footer is the
 * default; opening `/helm` SUSPENDS it (helm owns the whole viewport, so the footer
 * region must be a zero-line component — NOT removed, which would let pi's built-in
 * footer re-appear below helm); closing `/helm` RESTORES the same usage footer.
 *
 * The one rule this class exists to enforce: never `setFooter(undefined)` — that
 * hands the region back to pi's built-in footer and loses the usage footer. Every
 * transition goes through here so ownership can't drift (regression: the old
 * extensions/helm.ts exit path called setFooter(undefined)).
 */

/** Any factory pi's `setFooter` accepts. The zero-line factory below matches the shape. */
export type FooterFactory = unknown;

/** The slice of the pi UI this controller drives. */
export interface FooterHost {
  setFooter(factory: FooterFactory): void;
}

/** A footer that renders nothing — helm owns the viewport while it's installed. */
const ZERO_LINE: FooterFactory = () => ({ render: (): string[] => [], invalidate: () => {} });

export class FooterController {
  private usageFactory: FooterFactory | undefined;

  constructor(private readonly host: FooterHost) {}

  /** Install the usage footer as the REPL default and remember it as the restore target. */
  installUsageFooter(factory: FooterFactory): void {
    this.usageFactory = factory;
    this.host.setFooter(factory);
  }

  /** Hand the viewport to helm: a zero-line footer, never `undefined`. Reentrant. */
  suspendForFullScreen(): void {
    this.host.setFooter(ZERO_LINE);
  }

  /** Return to the usage footer (never the built-in). Safe to call more than once. */
  restore(): void {
    if (this.usageFactory !== undefined) this.host.setFooter(this.usageFactory);
  }
}

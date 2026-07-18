import type { DataSource } from "../data/source.js";

/** Live view of helm's UI ownership, read lazily at prompt time by backend registrars. */
export interface HelmPresence {
  /** True while /helm owns the full screen. */
  isOpen(): boolean;
  /** The composed RealDataSource once the composition root has built it. */
  dataSource(): DataSource | undefined;
}

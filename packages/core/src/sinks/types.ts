import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";

export interface WriteReport {
  duplicates: number;
  /** lineNumber → Wealthfolio activity id, for linking after import. */
  ids: Map<number, string>;
  imported: number;
  skipped: number;
}

export interface LinkReport {
  linked: number;
  /**
   * False for sinks that cannot express linking at all (CSV). The pairs are
   * still unlinked and still worth reporting, but that is a property of the
   * output format rather than a failure of this run.
   */
  supported: boolean;
  /**
   * Pairs that were detected but not linked. Never zero silently: an unlinked
   * pair means a synthesized card-side leg was written with nothing to net it
   * against, which double-counts that card payment permanently.
   */
  unlinked: number;
}

export interface Sink {
  link(pairs: PairPlan[]): Promise<LinkReport>;
  write(activities: ActivityImport[]): Promise<WriteReport>;
}

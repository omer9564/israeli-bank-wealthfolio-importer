import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";

export interface WriteReport {
  duplicates: number;
  /** lineNumber → Wealthfolio activity id, for linking after import. */
  ids: Map<number, string>;
  imported: number;
  skipped: number;
}

export interface Sink {
  link(pairs: PairPlan[]): Promise<number>;
  write(activities: ActivityImport[]): Promise<WriteReport>;
}

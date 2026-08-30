import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";
import type { WealthfolioClient } from "../wealthfolio/client";
import type { Sink, WriteReport } from "./types";

/**
 * `/activities/import` requires `isValid`/`isDraft`, which only the check pass
 * populates — so both calls are mandatory and ordered. Line numbers are assigned
 * here so the ids coming back off the import can be correlated for linking.
 */
export class ApiSink implements Sink {
  private readonly client: WealthfolioClient;

  constructor(client: WealthfolioClient) {
    this.client = client;
  }

  async write(activities: ActivityImport[]): Promise<WriteReport> {
    const ids = new Map<number, string>();
    if (activities.length === 0) {
      return { imported: 0, duplicates: 0, skipped: 0, ids };
    }

    const numbered = activities.map((activity, index) => ({
      ...activity,
      lineNumber: index,
    }));
    const checked = await this.client.checkImport(numbered);

    const duplicates = checked.filter(
      (row) => row.duplicateOfId !== undefined
    ).length;
    // A scheduled sync has no business overriding duplicate detection, so
    // `forceImport` stays false and flagged rows are simply dropped.
    const importable = checked.filter(
      (row) => row.duplicateOfId === undefined && row.isValid !== false
    );
    const skipped = checked.length - duplicates - importable.length;

    if (importable.length === 0) {
      return { imported: 0, duplicates, skipped, ids };
    }

    const result = await this.client.import(importable);
    for (const row of result.activities) {
      if (row.lineNumber !== undefined && row.id !== undefined) {
        ids.set(row.lineNumber, row.id);
      }
    }

    return {
      imported: result.summary.imported ?? importable.length,
      duplicates,
      skipped,
      ids,
    };
  }

  async link(pairs: PairPlan[]): Promise<number> {
    let linked = 0;
    for (const pair of pairs) {
      const outId = pair.out.id;
      const inId = pair.in.id;
      if (outId === undefined || inId === undefined) {
        continue;
      }
      await this.client.link(outId, inId);
      linked += 1;
    }
    return linked;
  }
}

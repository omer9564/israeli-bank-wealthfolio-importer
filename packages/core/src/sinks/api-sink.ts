import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";
import type { WealthfolioClient } from "../wealthfolio/client";
import type { LinkReport, Sink, WriteReport } from "./types";

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
      return {
        imported: 0,
        duplicates: 0,
        skipped: 0,
        ids,
        rejectionReasons: [],
      };
    }

    const numbered = activities.map((activity, index) => ({
      ...activity,
      lineNumber: index,
    }));
    const checked = await this.client.checkImport(numbered);

    const duplicates = checked.filter(
      (row) => row.duplicateOfId !== undefined
    ).length;
    // The window is a trailing rescan, so most rows already exist. Those are
    // dropped from the import below and their ids never appear in its response
    // — `duplicateOfId` is the only place they surface. Without recovering
    // them here, every pair whose legs already existed looks id-less, and a
    // fully-linked book reports "0 of N pairs linked" on every run after the
    // first.
    for (const row of checked) {
      if (row.lineNumber !== undefined && row.duplicateOfId !== undefined) {
        ids.set(row.lineNumber, row.duplicateOfId);
      }
    }
    // A scheduled sync has no business overriding duplicate detection, so
    // `forceImport` stays false and flagged rows are simply dropped.
    const importable = checked.filter(
      (row) => row.duplicateOfId === undefined && row.isValid !== false
    );
    const skipped = checked.length - duplicates - importable.length;
    const rejectionReasons = [
      ...new Set(
        checked
          .filter(
            (row) => row.duplicateOfId === undefined && row.isValid === false
          )
          .flatMap((row) =>
            Object.entries(row.errors ?? {}).flatMap(([field, messages]) =>
              messages.map((message) => `${field}: ${message}`)
            )
          )
      ),
    ].slice(0, 8);

    if (importable.length === 0) {
      return { imported: 0, duplicates, skipped, ids, rejectionReasons };
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
      rejectionReasons,
    };
  }

  /**
   * A pair whose legs came back without ids cannot be linked, and swallowing
   * that is what makes the failure invisible: the bank debit is usually a
   * server-side duplicate (so it gets no id) while the synthesized card leg is
   * new and imports fine, leaving an unlinked TRANSFER_IN on a CREDIT_CARD —
   * which Wealthfolio's classifier ignores, so it overstates the card balance
   * while appearing in no spending report. The skips are counted and returned
   * so `runSync` can fail the run over them.
   */
  async link(pairs: PairPlan[]): Promise<LinkReport> {
    let linked = 0;
    let unlinked = 0;
    for (const pair of pairs) {
      const outId = pair.out.id;
      const inId = pair.in.id;
      if (outId === undefined || inId === undefined) {
        unlinked += 1;
        continue;
      }
      // One failing pair must not abort the loop. A synthesized leg is written
      // before linking and the importer keeps no state to undo it with, so an
      // early throw would strand every later pair's leg permanently. Count the
      // failure instead — `runSync` still fails the run when `linked` falls
      // short of `pairsDetected`, just after every pair has had its turn.
      try {
        await this.client.link(outId, inId);
        linked += 1;
      } catch {
        unlinked += 1;
      }
    }
    return { linked, supported: true, unlinked };
  }
}

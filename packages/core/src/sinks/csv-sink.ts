import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";
import type { Sink, WriteReport } from "./types";

const HEADER = "date,activityType,amount,currency,fee,comment";
const NEEDS_QUOTING_PATTERN = /[",\n]/;

function cell(value: string): string {
  return NEEDS_QUOTING_PATTERN.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Wealthfolio's own activity-import columns, matching docs/test-data/credit-card-history.csv. */
export function toCsv(activities: ActivityImport[]): string {
  const rows = activities.map((activity) =>
    [
      activity.date,
      activity.activityType,
      String(activity.amount),
      activity.currency,
      String(activity.fee),
      cell(activity.comment),
    ].join(",")
  );
  return `${[HEADER, ...rows].join("\n")}\n`;
}

export interface CsvWriter {
  write(fileName: string, contents: string): Promise<void>;
}

/**
 * For desktop users and for --dry-run. There is no server to dedup, so output is
 * documented as "review before importing" rather than presented as safe to apply
 * repeatedly. Linking is not expressible in CSV.
 */
export class CsvSink implements Sink {
  private readonly writer: CsvWriter;

  constructor(writer: CsvWriter) {
    this.writer = writer;
  }

  async write(activities: ActivityImport[]): Promise<WriteReport> {
    const byAccount = new Map<string, ActivityImport[]>();
    for (const activity of activities) {
      const bucket = byAccount.get(activity.accountId) ?? [];
      bucket.push(activity);
      byAccount.set(activity.accountId, bucket);
    }

    for (const [accountId, rows] of byAccount) {
      await this.writer.write(`${accountId}.csv`, toCsv(rows));
    }

    return {
      imported: activities.length,
      duplicates: 0,
      skipped: 0,
      ids: new Map(),
    };
  }

  link(_pairs: PairPlan[]): Promise<number> {
    return Promise.resolve(0);
  }
}

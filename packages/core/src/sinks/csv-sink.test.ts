import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { CsvSink, toCsv } from "./csv-sink";

describe("toCsv", () => {
  test("emits Wealthfolio's import columns", () => {
    const csv = toCsv([
      {
        accountId: "a",
        activityType: "WITHDRAWAL",
        date: "2026-08-01T00:00:00.000Z",
        amount: 15.49,
        currency: "ILS",
        fee: 0,
        comment: "שופרסל",
        isDraft: false,
      },
    ]);
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe("date,activityType,amount,currency,fee,comment");
    expect(row).toBe("2026-08-01T00:00:00.000Z,WITHDRAWAL,15.49,ILS,0,שופרסל");
  });

  test("quotes and escapes commas and quotes in the comment", () => {
    const csv = toCsv([
      {
        accountId: "a",
        activityType: "WITHDRAWAL",
        date: "2026-08-01T00:00:00.000Z",
        amount: 1,
        currency: "ILS",
        fee: 0,
        comment: 'a,b "c"',
        isDraft: false,
      },
    ]);
    expect(csv.trim().split("\n")[1]).toContain('"a,b ""c"""');
  });
});

describe("CsvSink", () => {
  const leg = (over: Partial<ActivityImport>): ActivityImport => ({
    accountId: "a",
    activityType: "TRANSFER_OUT",
    date: "2026-08-01T00:00:00.000Z",
    amount: 1,
    currency: "ILS",
    fee: 0,
    comment: "c",
    isDraft: false,
    ...over,
  });

  test("reports detected pairs as unlinked, marked unsupported rather than failed", async () => {
    // CSV has no activity ids, so nothing can be linked — but the pairs are
    // still unlinked in the output, which really would double-count on import.
    const sink = new CsvSink({ write: () => Promise.resolve() });
    const report = await sink.link([
      {
        out: leg({}),
        in: leg({ activityType: "TRANSFER_IN" }),
        synthesized: true,
      },
    ]);

    expect(report).toEqual({ linked: 0, supported: false, unlinked: 1 });
  });
});

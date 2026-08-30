import { describe, expect, test } from "bun:test";
import { toCsv } from "./csv-sink";

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

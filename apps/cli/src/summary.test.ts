import { describe, expect, test } from "bun:test";
import { renderSummary } from "./summary";

const report = {
  startedAt: "2026-08-30T00:00:00.000Z",
  finishedAt: "2026-08-30T00:02:00.000Z",
  providers: [
    {
      id: "bank",
      ok: true,
      accounts: [{ accountNumber: "12-345", mapped: true, imported: 12 }],
    },
    { id: "card", ok: false, error: "invalidPassword: bad", accounts: [] },
  ],
  totals: { imported: 12, duplicates: 3, skipped: 0, linked: 1 },
  unmatchedCardPayments: 0,
  ok: false,
};

describe("renderSummary", () => {
  test("renders a markdown table of totals", () => {
    const output = renderSummary(report);
    expect(output).toContain("| bank | ok | 12 |");
    expect(output).toContain("Imported 12");
  });

  test("names the failing provider and its error", () => {
    expect(renderSummary(report)).toContain("invalidPassword: bad");
  });

  test("flags unmapped accounts so they do not go unnoticed", () => {
    const output = renderSummary({
      ...report,
      providers: [
        {
          id: "bank",
          ok: true,
          accounts: [{ accountNumber: "99", mapped: false, imported: 0 }],
        },
      ],
    });
    expect(output).toContain("99");
    expect(output).toContain("unmapped");
  });
});

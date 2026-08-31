import { describe, expect, test } from "bun:test";
import type { RunReport } from "@ibw/core";
import { renderSummary } from "./summary";

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:02:00.000Z",
    dryRun: false,
    providers: [
      {
        id: "bank",
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            mapped: true,
            mappedRows: 12,
            nonFiniteSkipped: 0,
            pendingSkipped: 0,
            zeroAmountSkipped: 0,
          },
        ],
      },
      { id: "card", ok: false, error: "invalidPassword: bad", accounts: [] },
    ],
    totals: {
      duplicates: 3,
      imported: 12,
      linked: 1,
      mappedRows: 12,
      nonFiniteSkipped: 0,
      pairsDetected: 1,
      pendingSkipped: 0,
      skipped: 0,
      unlinkedPairs: 0,
      zeroAmountSkipped: 0,
    },
    ambiguousCardPayments: 0,
    missingCardAccountIds: [],
    transferLinkingSupported: true,
    ok: false,
    ...over,
  };
}

describe("renderSummary", () => {
  test("renders a markdown table of per-provider mapped rows", () => {
    const output = renderSummary(report());
    expect(output).toContain("| bank | ok | 12 |");
    expect(output).toContain("Mapped 12 row(s) → imported 12");
  });

  test("names the failing provider and its error", () => {
    expect(renderSummary(report())).toContain("invalidPassword: bad");
  });

  test("flags unmapped accounts so they do not go unnoticed", () => {
    const output = renderSummary(
      report({
        providers: [
          {
            id: "bank",
            ok: true,
            accounts: [
              {
                accountNumber: "99",
                mapped: false,
                mappedRows: 0,
                nonFiniteSkipped: 0,
                pendingSkipped: 0,
                zeroAmountSkipped: 0,
              },
            ],
          },
        ],
      })
    );
    expect(output).toContain("99");
    expect(output).toContain("unmapped");
  });

  test("reports rows the server's check pass rejected", () => {
    // Previously `totals.skipped` had no consumer at all, so a run that
    // imported nothing rendered as a clean green summary.
    const output = renderSummary(
      report({
        totals: { ...report().totals, imported: 0, skipped: 12 },
      })
    );
    expect(output).toContain("rejected 12 row(s)");
    expect(output).toContain("imported 0");
  });

  test("distinguishes pending drops from unparsable ones", () => {
    const output = renderSummary(
      report({
        totals: { ...report().totals, pendingSkipped: 4, nonFiniteSkipped: 2 },
      })
    );
    expect(output).toContain("4 pending");
    expect(output).toContain("2 unparsable amount(s)");
    expect(output).toContain("not a finite number");
  });

  test("says plainly that unlinked pairs may double-count card spending", () => {
    const output = renderSummary(
      report({
        totals: { ...report().totals, linked: 0, unlinkedPairs: 1 },
      })
    );
    expect(output).toContain("1 of 1 detected transfer pair(s)");
    expect(output).toContain("double-counted");
  });

  test("shows why linking failed when the call itself threw", () => {
    const output = renderSummary(
      report({
        linkError: "connection reset",
        totals: { ...report().totals, linked: 0, unlinkedPairs: 1 },
      })
    );
    expect(output).toContain("Linking failed outright: connection reset");
    expect(output).toContain("double-counted");
  });

  test("frames unlinkable CSV pairs as a format limitation, not a failure", () => {
    const output = renderSummary(
      report({
        transferLinkingSupported: false,
        totals: { ...report().totals, linked: 0, unlinkedPairs: 1 },
      })
    );
    expect(output).toContain("CSV output cannot");
    expect(output).not.toContain("❌ 1 of 1");
  });

  test("names a cardPayments account missing from the run, without calling it ambiguous", () => {
    const output = renderSummary(
      report({ missingCardAccountIds: ["wf-typo"] })
    );
    expect(output).toContain("wf-typo");
    expect(output).toContain("typos");
    expect(output).not.toContain("equally");
  });

  test("calls an ambiguous counterpart ambiguous", () => {
    const output = renderSummary(report({ ambiguousCardPayments: 2 }));
    expect(output).toContain("2 card payment(s)");
    expect(output).toContain("equally");
  });

  test("explains an account that could not be anchored", () => {
    const base = report();
    const provider = base.providers[0];
    const account = provider?.accounts[0];
    if (provider === undefined || account === undefined) {
      throw new Error("fixture");
    }
    const output = renderSummary(
      report({
        providers: [
          {
            ...provider,
            accounts: [{ ...account, anchorFailure: "invalidForAccountType" }],
          },
        ],
      })
    );
    expect(output).toContain("could not be anchored");
    expect(output).toContain("DEPOSIT on a credit card");
  });

  test("warns that a dry run omits the opening-balance anchor", () => {
    const output = renderSummary(report({ dryRun: true }));
    expect(output).toContain("omits the opening-balance anchor");
  });

  test("says nothing about dry run on a real run", () => {
    expect(renderSummary(report())).not.toContain("Dry run");
  });
});

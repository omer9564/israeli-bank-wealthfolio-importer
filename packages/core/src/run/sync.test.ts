import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/schema";
import type { LinkReport, Sink, WriteReport } from "../sinks/types";
import type { ScrapedTransaction } from "../types";
import { runSync } from "./sync";

function config(over: Record<string, unknown> = {}) {
  return parseConfig({
    wealthfolio: { url: "http://wf:8080", password: "pw" },
    providers: [
      {
        id: "bank",
        companyId: "hapoalim",
        credentials: { userCode: "u", password: "p" },
        accounts: { "12-345": { wealthfolioAccountId: "acc-1", type: "CASH" } },
      },
    ],
    ...over,
  });
}

/** A config with both a bank and a card account, plus the cardPayments link. */
function cardConfig() {
  return parseConfig({
    wealthfolio: { url: "http://wf:8080", password: "pw" },
    cardPayments: [{ pattern: "ישראכרט", wealthfolioAccountId: "acc-card" }],
    providers: [
      {
        id: "bank",
        companyId: "hapoalim",
        credentials: { userCode: "u", password: "p" },
        accounts: {
          "12-345": { wealthfolioAccountId: "acc-1", type: "CASH" },
          "99-999": { wealthfolioAccountId: "acc-card", type: "CREDIT_CARD" },
        },
      },
    ],
  });
}

function recordingSink(over: Partial<Sink> = {}) {
  const written: unknown[][] = [];
  const sink: Sink = {
    write(activities) {
      written.push(activities);
      return Promise.resolve({
        imported: activities.length,
        duplicates: 0,
        skipped: 0,
        ids: new Map(activities.map((_, index) => [index, `id-${index}`])),
      });
    },
    link(pairs) {
      return Promise.resolve({
        linked: pairs.length,
        supported: true,
        unlinked: 0,
      });
    },
    ...over,
  };
  return { sink, written };
}

const txn: ScrapedTransaction = {
  type: "normal",
  date: "2026-08-10T00:00:00.000Z",
  processedDate: "2026-08-10T00:00:00.000Z",
  originalAmount: -100,
  originalCurrency: "ILS",
  chargedAmount: -100,
  chargedCurrency: "ILS",
  description: "סופר",
  status: "completed",
};

const cardDebit: ScrapedTransaction = {
  ...txn,
  chargedAmount: -5000,
  originalAmount: -5000,
  description: "ישראכרט חיוב חודשי",
};

const cardPurchase: ScrapedTransaction = {
  ...txn,
  chargedAmount: -300,
  originalAmount: -300,
  description: "קפה",
};

/**
 * Both accounts of `cardConfig`, so the CREDIT_CARD bucket exists and the
 * declared cardPayments target can actually be found.
 */
const bothAccounts = [
  { accountNumber: "12-345", currency: "ILS", txns: [cardDebit] },
  { accountNumber: "99-999", currency: "ILS", txns: [cardPurchase] },
];

describe("runSync", () => {
  test("maps and writes transactions for a mapped account", async () => {
    const { sink, written } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            balance: 900,
            currency: "ILS",
            txns: [txn],
          },
        ],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.totals.imported).toBe(1);
    expect(report.totals.mappedRows).toBe(1);
    expect(written[0]).toHaveLength(1);
  });

  test("adds a balance anchor only when the account is empty", async () => {
    const { sink, written } = recordingSink();
    await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            balance: 900,
            currency: "ILS",
            txns: [txn],
          },
        ],
      }),
      hasActivities: async () => false,
    });

    const rows = written[0] as { comment: string }[];
    expect(rows).toHaveLength(2);
    expect(
      rows.some((row) => row.comment.startsWith("Opening balance anchor"))
    ).toBe(true);
  });

  test("reports unmapped accounts without failing the run", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [{ accountNumber: "99-999", txns: [txn] }],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.providers[0]?.accounts[0]).toMatchObject({
      accountNumber: "99-999",
      mapped: false,
    });
  });

  test("marks the run failed when a provider fails, and keeps the message", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: false,
        errorType: "invalidPassword",
        errorMessage: "bad",
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.providers[0]?.error).toContain("invalidPassword");
  });

  test("scrapes from now minus daysBack, not from a stored watermark", async () => {
    const { sink } = recordingSink();
    let seen: Date | undefined;
    await runSync(config({ daysBack: 10 }), {
      sink,
      scrape: (_provider, startDate) => {
        seen = startDate;
        return Promise.resolve({ ok: true, accounts: [] });
      },
      hasActivities: async () => true,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(seen?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  test("counts pending, zero and non-finite drops separately per account", async () => {
    // A provider whose HTML parse regressed to NaN on every row must not look
    // identical to an account with no activity.
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            currency: "ILS",
            txns: [
              txn,
              { ...txn, status: "pending" as const },
              { ...txn, chargedAmount: 0 },
              { ...txn, chargedAmount: Number.NaN },
              { ...txn, chargedAmount: Number.POSITIVE_INFINITY },
            ],
          },
        ],
      }),
      hasActivities: async () => true,
    });

    expect(report.providers[0]?.accounts[0]).toMatchObject({
      mappedRows: 1,
      pendingSkipped: 1,
      zeroAmountSkipped: 1,
      nonFiniteSkipped: 2,
    });
    expect(report.totals).toMatchObject({
      mappedRows: 1,
      pendingSkipped: 1,
      zeroAmountSkipped: 1,
      nonFiniteSkipped: 2,
    });
  });

  test("fails the run when the scraper produced non-finite amounts", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            currency: "ILS",
            txns: [{ ...txn, chargedAmount: Number.NaN }],
          },
        ],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(false);
  });

  test("does not fail a run whose only drops were pending charges", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "12-345",
            currency: "ILS",
            txns: [txn, { ...txn, status: "pending" as const }],
          },
        ],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.totals.pendingSkipped).toBe(1);
  });

  test("fails the run when the server's check pass rejected rows", async () => {
    // A run that imports nothing because every row was rejected must not
    // report success.
    const { sink } = recordingSink({
      write(activities): Promise<WriteReport> {
        return Promise.resolve({
          imported: 0,
          duplicates: 0,
          skipped: activities.length,
          ids: new Map(),
        });
      },
    });
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [{ accountNumber: "12-345", currency: "ILS", txns: [txn] }],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.totals.skipped).toBe(1);
    expect(report.totals.imported).toBe(0);
  });

  test("fails the run when a detected transfer pair could not be linked", async () => {
    // The permanent-duplicate case: the bank debit is deduplicated server-side
    // so no id comes back for it, while the synthesized card leg imports fine
    // and is never netted against anything.
    const { sink } = recordingSink({
      link(pairs): Promise<LinkReport> {
        return Promise.resolve({
          linked: 0,
          supported: true,
          unlinked: pairs.length,
        });
      },
    });
    const report = await runSync(cardConfig(), {
      sink,
      scrape: async () => ({ ok: true, accounts: bothAccounts }),
      hasActivities: async () => true,
    });

    expect(report.totals.pairsDetected).toBe(1);
    expect(report.totals.linked).toBe(0);
    expect(report.totals.unlinkedPairs).toBe(1);
    expect(report.ok).toBe(false);
  });

  test("treats a throwing link call as unlinked pairs, not as a lost summary", async () => {
    // A throw after a successful write strands the legs exactly as a silent
    // skip does, so it must produce the same report rather than escape.
    const { sink } = recordingSink({
      link(): Promise<LinkReport> {
        return Promise.reject(new Error("connection reset"));
      },
    });
    const report = await runSync(cardConfig(), {
      sink,
      scrape: async () => ({ ok: true, accounts: bothAccounts }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.totals.unlinkedPairs).toBe(1);
    expect(report.linkError).toContain("connection reset");
  });

  test("passes when every detected pair was linked", async () => {
    const { sink } = recordingSink();
    const report = await runSync(cardConfig(), {
      sink,
      scrape: async () => ({ ok: true, accounts: bothAccounts }),
      hasActivities: async () => true,
    });

    expect(report.totals.pairsDetected).toBe(1);
    expect(report.totals.linked).toBe(1);
    expect(report.ok).toBe(true);
  });

  test("does not fail a dry run for pairs a CSV simply cannot link", async () => {
    const { sink } = recordingSink({
      link(pairs): Promise<LinkReport> {
        return Promise.resolve({
          linked: 0,
          supported: false,
          unlinked: pairs.length,
        });
      },
    });
    const report = await runSync(cardConfig(), {
      sink,
      dryRun: true,
      scrape: async () => ({ ok: true, accounts: bothAccounts }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(report.totals.unlinkedPairs).toBe(1);
    expect(report.transferLinkingSupported).toBe(false);
  });

  test("reports an un-anchorable credit card instead of skipping it silently", async () => {
    const { sink, written } = recordingSink();
    const report = await runSync(cardConfig(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [
          {
            accountNumber: "99-999",
            balance: 0,
            currency: "ILS",
            txns: [{ ...txn, chargedAmount: -300, originalAmount: -300 }],
          },
        ],
      }),
      hasActivities: async () => false,
    });

    expect(report.providers[0]?.accounts[0]?.anchorFailure).toBe(
      "invalidForAccountType"
    );
    // The purchase is still imported; only the anchor is withheld.
    expect(written[0]).toHaveLength(1);
  });

  test("names a cardPayments account that was not part of this run", async () => {
    // Reported as a missing account, NOT as an ambiguous counterpart: the
    // fixes are in different places and the second diagnosis sends the user
    // looking for competing card credits that do not exist.
    const { sink } = recordingSink();
    const report = await runSync(cardConfig(), {
      sink,
      scrape: async () => ({
        ok: true,
        // The card account was not returned by this run at all.
        accounts: [
          { accountNumber: "12-345", currency: "ILS", txns: [cardDebit] },
        ],
      }),
      hasActivities: async () => true,
    });

    expect(report.missingCardAccountIds).toEqual(["acc-card"]);
    expect(report.ambiguousCardPayments).toBe(0);
    expect(report.totals.pairsDetected).toBe(0);
  });
});

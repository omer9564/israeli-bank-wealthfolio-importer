import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/schema";
import type { Sink } from "../sinks/types";
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

function recordingSink() {
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
      return Promise.resolve(pairs.length);
    },
  };
  return { sink, written };
}

const txn = {
  type: "normal" as const,
  date: "2026-08-10T00:00:00.000Z",
  processedDate: "2026-08-10T00:00:00.000Z",
  originalAmount: -100,
  originalCurrency: "ILS",
  chargedAmount: -100,
  chargedCurrency: "ILS",
  description: "סופר",
  status: "completed" as const,
};

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
});

import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { ApiSink } from "./api-sink";

function activity(over: Partial<ActivityImport> = {}): ActivityImport {
  return {
    accountId: "acc-1",
    activityType: "WITHDRAWAL",
    date: "2026-08-01T00:00:00.000Z",
    amount: 10,
    currency: "ILS",
    fee: 0,
    comment: "c",
    isDraft: false,
    ...over,
  };
}

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      checkImport(rows: ActivityImport[]) {
        calls.push("check");
        return rows.map((row) => ({ ...row, isValid: true }));
      },
      import(rows: ActivityImport[]) {
        calls.push("import");
        return {
          activities: rows.map((row) => ({
            ...row,
            id: `id-${row.lineNumber}`,
          })),
          importRunId: "run",
          summary: {
            total: rows.length,
            imported: rows.length,
            skipped: 0,
            duplicates: 0,
          },
        };
      },
      link() {
        calls.push("link");
      },
      ...over,
    } as never,
  };
}

describe("ApiSink", () => {
  test("checks before importing and assigns line numbers", async () => {
    const { client, calls } = fakeClient();
    const sink = new ApiSink(client);
    const report = await sink.write([activity(), activity()]);

    expect(calls).toEqual(["check", "import"]);
    expect(report.imported).toBe(2);
    expect(report.ids.get(0)).toBe("id-0");
  });

  test("drops rows the server flagged as duplicates instead of forcing them", async () => {
    const { client } = fakeClient({
      checkImport(rows: ActivityImport[]) {
        return rows.map((row, index) => ({
          ...row,
          isValid: true,
          ...(index === 0 ? { duplicateOfId: "existing" } : {}),
        }));
      },
    });
    const sink = new ApiSink(client);
    const report = await sink.write([activity(), activity()]);

    expect(report.duplicates).toBe(1);
    expect(report.imported).toBe(1);
  });

  test("drops invalid rows and counts them as skipped", async () => {
    const { client } = fakeClient({
      checkImport(rows: ActivityImport[]) {
        return rows.map((row) => ({ ...row, isValid: false }));
      },
    });
    const report = await new ApiSink(client).write([activity()]);
    expect(report.skipped).toBe(1);
    expect(report.imported).toBe(0);
  });

  test("does not call the API at all for an empty batch", async () => {
    const { client, calls } = fakeClient();
    await new ApiSink(client).write([]);
    expect(calls).toEqual([]);
  });

  test("links a pair whose legs both came back with ids", async () => {
    const { client, calls } = fakeClient();
    const report = await new ApiSink(client).link([
      {
        out: activity({ id: "a" }),
        in: activity({ id: "b" }),
        synthesized: true,
      },
    ]);

    expect(calls).toEqual(["link"]);
    expect(report).toEqual({ linked: 1, supported: true, unlinked: 0 });
  });

  test("counts a pair with an id-less leg instead of silently skipping it", async () => {
    // The bank debit is usually a server-side duplicate, so no id comes back
    // for it — while the synthesized card leg is new and imports fine. Skipping
    // this quietly leaves an unlinked TRANSFER_IN on a CREDIT_CARD, which
    // Wealthfolio ignores while it still moves the balance, permanently.
    const { client, calls } = fakeClient();
    const report = await new ApiSink(client).link([
      { out: activity({}), in: activity({ id: "b" }), synthesized: true },
    ]);

    expect(calls).toEqual([]);
    expect(report).toEqual({ linked: 0, supported: true, unlinked: 1 });
  });
});

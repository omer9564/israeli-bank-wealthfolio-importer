import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { buildAnchor, netEffect } from "./balance-anchor";

function activity(over: Partial<ActivityImport>): ActivityImport {
  return {
    accountId: "acc-1",
    activityType: "WITHDRAWAL",
    date: "2026-08-10T00:00:00.000Z",
    amount: 100,
    currency: "ILS",
    fee: 0,
    comment: "x",
    isDraft: false,
    ...over,
  };
}

describe("netEffect", () => {
  test("nets inflows against outflows", () => {
    const net = netEffect(
      [
        activity({ activityType: "DEPOSIT", amount: 500 }),
        activity({ amount: 200 }),
      ],
      "CASH"
    );
    expect(net).toBe(300);
  });
});

describe("buildAnchor", () => {
  const activities = [
    activity({ activityType: "DEPOSIT", amount: 500 }),
    activity({ amount: 200 }),
  ];

  test("emits a DEPOSIT for the shortfall, dated before the earliest activity", () => {
    const anchor = buildAnchor({
      accountId: "acc-1",
      accountType: "CASH",
      scrapedBalance: 1000,
      balanceDate: "2026-08-20",
      activities,
    });
    expect(anchor).toMatchObject({
      activityType: "DEPOSIT",
      amount: 700,
      currency: "ILS",
    });
    expect(anchor?.comment).toContain("2026-08-20");
    expect(
      new Date(anchor?.date ?? 0) < new Date("2026-08-10T00:00:00.000Z")
    ).toBe(true);
  });

  test("emits a WITHDRAWAL when imported activity overshoots the real balance", () => {
    const anchor = buildAnchor({
      accountId: "acc-1",
      accountType: "CASH",
      scrapedBalance: 100,
      activities,
    });
    expect(anchor).toMatchObject({ activityType: "WITHDRAWAL", amount: 200 });
  });

  test("returns null when the balance already matches", () => {
    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        scrapedBalance: 300,
        activities,
      })
    ).toBeNull();
  });

  test("returns null when there is nothing to anchor against", () => {
    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        scrapedBalance: 300,
        activities: [],
      })
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import type { ActivityImport, WealthfolioAccountType } from "../types";
import type { AnchorOutcome } from "./balance-anchor";
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

/** The anchor row itself, or null when none was produced. */
function anchorOf(outcome: AnchorOutcome): ActivityImport | null {
  return outcome.ok ? outcome.anchor : null;
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
    const anchor = anchorOf(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 1000,
        balanceDate: "2026-08-20",
        activities,
      })
    );
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
    const anchor = anchorOf(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 100,
        activities,
      })
    );
    expect(anchor).toMatchObject({ activityType: "WITHDRAWAL", amount: 200 });
  });

  test("reports the balance as already matching rather than emitting nothing", () => {
    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 300,
        activities,
      })
    ).toEqual({ ok: false, reason: "alreadyBalanced" });
  });

  test("reports when there is nothing to anchor against", () => {
    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 300,
        activities: [],
      })
    ).toEqual({ ok: false, reason: "noActivitiesInCurrency" });
  });

  test("nets only the account's currency in a mixed-currency batch", () => {
    const mixed = [
      activity({ activityType: "DEPOSIT", amount: 500, currency: "ILS" }),
      activity({ amount: 200, currency: "ILS" }),
      activity({
        activityType: "DEPOSIT",
        amount: 9999,
        currency: "USD",
        date: "2026-08-05T00:00:00.000Z",
      }),
    ];

    const anchor = anchorOf(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 1000,
        activities: mixed,
      })
    );

    expect(anchor).toMatchObject({
      activityType: "DEPOSIT",
      amount: 700,
      currency: "ILS",
    });
    // The date must come from the ILS rows only. The USD row is the earliest
    // in the batch, so computing it over the unfiltered list would date the
    // anchor a day before 2026-08-05 instead of a day before 2026-08-10.
    expect(anchor?.date).toBe("2026-08-09T00:00:00.000Z");
  });

  test("reports when no activity matches the account's currency", () => {
    const usdOnly = [
      activity({ activityType: "DEPOSIT", amount: 500, currency: "USD" }),
    ];

    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: 1000,
        activities: usdOnly,
      })
    ).toEqual({ ok: false, reason: "noActivitiesInCurrency" });
  });

  test("reports a non-finite scraped balance rather than posting NaN", () => {
    expect(
      buildAnchor({
        accountId: "acc-1",
        accountType: "CASH",
        currency: "ILS",
        scrapedBalance: Number.NaN,
        activities,
      })
    ).toEqual({ ok: false, reason: "nonFiniteBalance" });
  });
});

describe("buildAnchor on a CREDIT_CARD", () => {
  // One purchase: netEffect on a card is -300.
  const purchases = [activity({ accountId: "card", amount: 300 })];

  function cardAnchor(scrapedBalance: number, accountType?: string) {
    return buildAnchor({
      accountId: "card",
      accountType: (accountType ?? "CREDIT_CARD") as WealthfolioAccountType,
      currency: "ILS",
      scrapedBalance,
      activities: purchases,
    });
  }

  test("emits a WITHDRAWAL when the card owes more than the scraped purchases", () => {
    expect(anchorOf(cardAnchor(-500))).toMatchObject({
      activityType: "WITHDRAWAL",
      amount: 200,
    });
  });

  test("refuses to anchor a paid-off card rather than emitting DEPOSIT", () => {
    // Wealthfolio's classifier IGNORES a DEPOSIT on a credit card, so this row
    // would import cleanly and then be invisible in every spending report
    // while still moving the balance. Balance 0 is the common case.
    expect(cardAnchor(0)).toEqual({
      ok: false,
      reason: "invalidForAccountType",
    });
  });

  test("refuses to anchor a card in credit rather than emitting DEPOSIT", () => {
    expect(cardAnchor(250)).toEqual({
      ok: false,
      reason: "invalidForAccountType",
    });
  });

  test("still anchors the same figures on a CASH account", () => {
    // Proves the refusal is about the account type, not about the arithmetic.
    expect(anchorOf(cardAnchor(0, "CASH"))).toMatchObject({
      activityType: "DEPOSIT",
      amount: 300,
    });
  });
});

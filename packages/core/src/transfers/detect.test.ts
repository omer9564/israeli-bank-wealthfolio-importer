import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { detectCardPayments } from "./detect";

function activity(over: Partial<ActivityImport>): ActivityImport {
  return {
    accountId: "bank",
    activityType: "WITHDRAWAL",
    date: "2026-08-02T00:00:00.000Z",
    amount: 5000,
    currency: "ILS",
    fee: 0,
    comment: "ישראכרט חיוב חודשי",
    isDraft: false,
    ...over,
  };
}

const cardPayments = [{ pattern: "ישראכרט", wealthfolioAccountId: "card" }];

function buckets(bank: ActivityImport[], card: ActivityImport[] = []) {
  return [
    { accountId: "bank", accountType: "CASH" as const, activities: bank },
    {
      accountId: "card",
      accountType: "CREDIT_CARD" as const,
      activities: card,
    },
  ];
}

describe("detectCardPayments", () => {
  test("pairs a bank debit with an existing card-side credit", () => {
    const debit = activity({});
    const credit = activity({
      accountId: "card",
      activityType: "CREDIT",
      subtype: "REFUND",
      date: "2026-08-03T00:00:00.000Z",
      comment: "תשלום",
    });

    const result = detectCardPayments(buckets([debit], [credit]), {
      cardPayments,
      windowDays: 5,
    });

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.synthesized).toBe(false);
    expect(debit.activityType).toBe("TRANSFER_OUT");
    expect(credit.activityType).toBe("TRANSFER_IN");
  });

  test("synthesizes the card-side leg when the card reports only purchases", () => {
    const debit = activity({});
    const result = detectCardPayments(buckets([debit]), {
      cardPayments,
      windowDays: 5,
    });

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.synthesized).toBe(true);
    expect(result.pairs[0]?.in).toMatchObject({
      accountId: "card",
      activityType: "TRANSFER_IN",
      amount: 5000,
    });
    expect(debit.activityType).toBe("TRANSFER_OUT");
  });

  test("leaves a debit alone when two card credits could match", () => {
    const debit = activity({});
    const a = activity({
      accountId: "card",
      activityType: "CREDIT",
      comment: "תשלום א",
    });
    const b = activity({
      accountId: "card",
      activityType: "CREDIT",
      comment: "תשלום ב",
    });

    const result = detectCardPayments(buckets([debit], [a, b]), {
      cardPayments,
      windowDays: 5,
    });

    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched).toContain(debit);
    expect(debit.activityType).toBe("WITHDRAWAL");
  });

  test("does not match outside the date window", () => {
    const debit = activity({});
    const credit = activity({
      accountId: "card",
      activityType: "CREDIT",
      date: "2026-08-20T00:00:00.000Z",
    });

    const result = detectCardPayments(buckets([debit], [credit]), {
      cardPayments,
      windowDays: 5,
    });
    expect(result.pairs[0]?.synthesized).toBe(true);
  });

  test("ignores debits that match no declared pattern", () => {
    const debit = activity({ comment: "סופרמרקט" });
    const result = detectCardPayments(buckets([debit]), {
      cardPayments,
      windowDays: 5,
    });
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(debit.activityType).toBe("WITHDRAWAL");
  });

  test("does nothing when no card payments are declared", () => {
    const debit = activity({});
    const result = detectCardPayments(buckets([debit]), {
      cardPayments: [],
      windowDays: 5,
    });
    expect(result.pairs).toHaveLength(0);
  });

  test("reports the debit as unmatched when the declared card account is absent from this run", () => {
    const debit = activity({});
    const rules = [
      { pattern: "ישראכרט", wealthfolioAccountId: "missing-card" },
    ];

    const result = detectCardPayments(buckets([debit]), {
      cardPayments: rules,
      windowDays: 5,
    });

    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched).toContain(debit);
    expect(debit.activityType).toBe("WITHDRAWAL");
  });
});

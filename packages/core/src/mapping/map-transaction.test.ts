import { describe, expect, test } from "bun:test";
import type { ScrapedTransaction } from "../types";
import { buildComment, mapTransaction } from "./map-transaction";
import { DEFAULT_RULES } from "./rules";

function txn(over: Partial<ScrapedTransaction> = {}): ScrapedTransaction {
  return {
    type: "normal",
    date: "2026-08-01T00:00:00.000Z",
    processedDate: "2026-08-01T00:00:00.000Z",
    originalAmount: -120.5,
    originalCurrency: "ILS",
    chargedAmount: -120.5,
    chargedCurrency: "ILS",
    description: "שופרסל דיל",
    status: "completed",
    ...over,
  };
}

const cash = {
  accountId: "acc-1",
  accountType: "CASH" as const,
  fallbackCurrency: "ILS",
  rules: DEFAULT_RULES,
};

describe("buildComment", () => {
  test("keeps the Hebrew description intact", () => {
    expect(buildComment(txn())).toBe("שופרסל דיל");
  });

  test("appends memo, installment counter and asmachta", () => {
    const comment = buildComment(
      txn({
        memo: "סניף 42",
        installments: { number: 2, total: 12 },
        identifier: 998_877,
      })
    );
    expect(comment).toBe("שופרסל דיל · סניף 42 · תשלום 2/12 · אסמכתא 998877");
  });

  test("records the original amount when the charge was converted", () => {
    const comment = buildComment(
      txn({
        originalAmount: -30,
        originalCurrency: "USD",
        chargedCurrency: "ILS",
      })
    );
    expect(comment).toBe("שופרסל דיל · 30 USD");
  });
});

describe("mapTransaction", () => {
  test("maps a cash outflow to an unsigned WITHDRAWAL", () => {
    const outcome = mapTransaction(txn(), cash);
    expect(outcome.ok && outcome.activity).toMatchObject({
      accountId: "acc-1",
      activityType: "WITHDRAWAL",
      amount: 120.5,
      currency: "ILS",
      fee: 0,
      isDraft: false,
    });
  });

  test("maps a cash inflow to DEPOSIT", () => {
    const outcome = mapTransaction(
      txn({ chargedAmount: 9000, description: "משכורת" }),
      cash
    );
    expect(outcome.ok && outcome.activity).toMatchObject({
      activityType: "DEPOSIT",
      amount: 9000,
    });
  });

  test("reports a pending transaction as skipped, not as an unexplained null", () => {
    expect(mapTransaction(txn({ status: "pending" }), cash)).toEqual({
      ok: false,
      reason: "pending",
    });
  });

  test("reports a zero-amount transaction with its own reason", () => {
    expect(mapTransaction(txn({ chargedAmount: 0 }), cash)).toEqual({
      ok: false,
      reason: "zeroAmount",
    });
  });

  test("reports a NaN charged amount as a parse failure, distinct from pending", () => {
    expect(mapTransaction(txn({ chargedAmount: Number.NaN }), cash)).toEqual({
      ok: false,
      reason: "nonFiniteAmount",
    });
  });

  test("reports an Infinity charged amount as a parse failure", () => {
    expect(
      mapTransaction(txn({ chargedAmount: Number.POSITIVE_INFINITY }), cash)
    ).toEqual({ ok: false, reason: "nonFiniteAmount" });
  });

  test("falls back to the account currency when the charge has none", () => {
    const outcome = mapTransaction(txn({ chargedCurrency: undefined }), {
      ...cash,
      fallbackCurrency: "USD",
    });
    expect(outcome.ok && outcome.activity.currency).toBe("USD");
  });

  test("maps a card refund to CREDIT, never DEPOSIT", () => {
    const outcome = mapTransaction(
      txn({ chargedAmount: 55, description: "זיכוי" }),
      {
        ...cash,
        accountType: "CREDIT_CARD",
      }
    );
    expect(outcome.ok && outcome.activity.activityType).toBe("CREDIT");
  });
});

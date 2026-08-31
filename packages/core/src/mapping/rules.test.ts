import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RULES,
  directionOf,
  isTypeValidForAccount,
  resolveActivityType,
} from "./rules";

describe("isTypeValidForAccount", () => {
  test("rejects DEPOSIT on a credit card - Wealthfolio silently ignores it", () => {
    expect(isTypeValidForAccount("DEPOSIT", "CREDIT_CARD")).toBe(false);
  });

  test("rejects a subtype-less CREDIT on cash - also silently ignored", () => {
    expect(isTypeValidForAccount("CREDIT", "CASH")).toBe(false);
    expect(isTypeValidForAccount("CREDIT", "CASH", "REFUND")).toBe(true);
  });

  test("accepts a subtype-less CREDIT on a credit card", () => {
    expect(isTypeValidForAccount("CREDIT", "CREDIT_CARD")).toBe(true);
  });
});

describe("directionOf", () => {
  test("INTEREST is income on cash but a charge on a credit card", () => {
    expect(directionOf("INTEREST", "CASH")).toBe("inflow");
    expect(directionOf("INTEREST", "CREDIT_CARD")).toBe("outflow");
  });
});

describe("resolveActivityType", () => {
  test("falls back to sign on an unmatched cash transaction", () => {
    expect(resolveActivityType("סופרמרקט", false, "CASH", [])).toEqual({
      activityType: "WITHDRAWAL",
    });
    expect(resolveActivityType("משכורת", true, "CASH", [])).toEqual({
      activityType: "DEPOSIT",
    });
  });

  test("falls back to CREDIT with a REFUND subtype for a card inflow", () => {
    expect(resolveActivityType("זיכוי", true, "CREDIT_CARD", [])).toEqual({
      activityType: "CREDIT",
      subtype: "REFUND",
    });
  });

  test("applies a matching rule", () => {
    expect(
      resolveActivityType("עמלת שורה", false, "CASH", DEFAULT_RULES)
    ).toEqual({
      activityType: "FEE",
    });
  });

  test("ignores a rule whose direction contradicts the transaction sign", () => {
    // "ריבית חובה" is a charge, not income. The INTEREST rule is inflow-only on
    // cash, so an outflow must not be typed INTEREST and counted as income.
    const result = resolveActivityType(
      "ריבית חובה",
      false,
      "CASH",
      DEFAULT_RULES
    );
    expect(result.activityType).not.toBe("INTEREST");
  });

  test("ignores a rule that is invalid for the account type", () => {
    const rules = [{ pattern: "החזר", activityType: "DEPOSIT" as const }];
    expect(resolveActivityType("החזר", true, "CREDIT_CARD", rules)).toEqual({
      activityType: "CREDIT",
      subtype: "REFUND",
    });
  });

  test("user rules take precedence over defaults in order", () => {
    const rules = [
      { pattern: "עמלת", activityType: "TAX" as const },
      ...DEFAULT_RULES,
    ];
    expect(resolveActivityType("עמלת", false, "CASH", rules).activityType).toBe(
      "TAX"
    );
  });
});

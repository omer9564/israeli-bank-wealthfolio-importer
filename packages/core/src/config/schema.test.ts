import { describe, expect, test } from "bun:test";
import { parseConfig } from "./schema";

const USER_CODE_FIELD = /userCode/;
const ONE_ZERO_PROVIDER = /oneZero/;
const USERNAME_FIELD = /username/;
const UNDECLARED_CARD_ACCOUNT = /is not declared under any provider's accounts/;

const base = {
  wealthfolio: { url: "http://localhost:8080", password: "pw" },
  providers: [
    {
      id: "bank",
      companyId: "hapoalim",
      credentials: { userCode: "u", password: "p" },
      accounts: { "12-345": { wealthfolioAccountId: "acc-1", type: "CASH" } },
    },
  ],
};

describe("parseConfig", () => {
  test("accepts a minimal config and applies defaults", () => {
    const config = parseConfig(base);
    expect(config.daysBack).toBe(30);
    expect(config.transferWindowDays).toBe(5);
    expect(config.linkTransfers).toBe(true);
  });

  test("rejects hapoalim credentials of the wrong shape, naming the field", () => {
    const bad = {
      ...base,
      providers: [
        { ...base.providers[0], credentials: { username: "u", password: "p" } },
      ],
    };
    expect(() => parseConfig(bad)).toThrow(USER_CODE_FIELD);
  });

  test("accepts isracard credentials with card6Digits", () => {
    const config = parseConfig({
      ...base,
      providers: [
        {
          id: "card",
          companyId: "isracard",
          credentials: { id: "1", password: "p", card6Digits: "123456" },
          accounts: {
            "1234": { wealthfolioAccountId: "acc-2", type: "CREDIT_CARD" },
          },
        },
      ],
    });
    expect(config.providers[0]?.companyId).toBe("isracard");
  });

  test("rejects an OTP-only provider with a message naming it", () => {
    const otp = {
      ...base,
      providers: [
        {
          id: "oz",
          companyId: "oneZero",
          credentials: { email: "a@b.c", password: "p" },
          accounts: {},
        },
      ],
    };
    expect(() => parseConfig(otp)).toThrow(ONE_ZERO_PROVIDER);
  });

  test("rejects an unknown companyId", () => {
    expect(() =>
      parseConfig({
        ...base,
        providers: [{ ...base.providers[0], companyId: "nope" }],
      })
    ).toThrow();
  });

  test("parses card payment declarations naming a declared account", () => {
    const config = parseConfig({
      ...base,
      cardPayments: [{ pattern: "ישראכרט", wealthfolioAccountId: "acc-1" }],
    });
    expect(config.cardPayments[0]?.pattern).toBe("ישראכרט");
  });

  test("rejects a cardPayments target that no provider declares", () => {
    // Left to run time this surfaces as "could not be paired", which reads as
    // a matching problem and sends the user hunting for card credits that do
    // not exist. It is a typo, so it fails at startup.
    expect(() =>
      parseConfig({
        ...base,
        cardPayments: [{ pattern: "ישראכרט", wealthfolioAccountId: "acc-2" }],
      })
    ).toThrow(UNDECLARED_CARD_ACCOUNT);
  });

  test("accepts pagi credentials with username and password", () => {
    const config = parseConfig({
      ...base,
      providers: [
        {
          id: "pagi-bank",
          companyId: "pagi",
          credentials: { username: "u", password: "p" },
          accounts: {
            "1234": { wealthfolioAccountId: "acc-3", type: "CASH" },
          },
        },
      ],
    });
    expect(config.providers[0]?.companyId).toBe("pagi");
  });

  test("accepts beyahadBishvilha credentials with id and password, and does not reject it as OTP-only", () => {
    const config = parseConfig({
      ...base,
      providers: [
        {
          id: "byb",
          companyId: "beyahadBishvilha",
          credentials: { id: "1", password: "p" },
          accounts: {
            "1234": { wealthfolioAccountId: "acc-4", type: "CASH" },
          },
        },
      ],
    });
    expect(config.providers[0]?.companyId).toBe("beyahadBishvilha");
  });

  test("rejects pagi credentials of the wrong shape, naming the field", () => {
    const bad = {
      ...base,
      providers: [
        {
          id: "pagi-bank",
          companyId: "pagi",
          credentials: { userCode: "u", password: "p" },
          accounts: {
            "1234": { wealthfolioAccountId: "acc-3", type: "CASH" },
          },
        },
      ],
    };
    expect(() => parseConfig(bad)).toThrow(USERNAME_FIELD);
  });
});

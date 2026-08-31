import { describe, expect, test } from "bun:test";
import { collectSecrets, createRedactor } from "./redact";

describe("createRedactor", () => {
  test("replaces every occurrence of every secret", () => {
    const redact = createRedactor(["hunter2", "s3cret"]);
    expect(redact("login hunter2 then s3cret then hunter2")).toBe(
      "login [REDACTED] then [REDACTED] then [REDACTED]"
    );
  });

  test("treats secrets as literals, not patterns", () => {
    const redact = createRedactor(["a.c"]);
    expect(redact("abc a.c")).toBe("abc [REDACTED]");
  });

  test("ignores empty and very short secrets to avoid shredding output", () => {
    const redact = createRedactor(["", "ab"]);
    expect(redact("ab cd")).toBe("ab cd");
  });
});

describe("collectSecrets", () => {
  test("gathers every credential value and the Wealthfolio password", () => {
    const secrets = collectSecrets({
      wealthfolio: { url: "http://x", password: "wf-pass" },
      daysBack: 30,
      linkTransfers: true,
      transferWindowDays: 5,
      rules: [],
      cardPayments: [],
      providers: [
        {
          id: "b",
          companyId: "hapoalim",
          credentials: { userCode: "user-code", password: "bank-pass" },
          accounts: {},
        },
      ],
    } as never);

    expect(secrets).toContain("wf-pass");
    expect(secrets).toContain("bank-pass");
    expect(secrets).toContain("user-code");
  });
});

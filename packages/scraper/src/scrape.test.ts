import { describe, expect, test } from "bun:test";
import { buildScraperOptions, toOutcome } from "./scrape";

describe("buildScraperOptions", () => {
  test("never combines installments, so each charge lands on its own date", () => {
    const options = buildScraperOptions({ companyId: "isracard" } as never, {
      startDate: new Date("2026-07-01"),
    });
    expect(options.combineInstallments).toBe(false);
  });

  test("runs headless with a sandbox-safe argument set", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
    });
    expect(options.showBrowser).toBe(false);
    expect(options.args).toContain("--no-sandbox");
  });

  test("passes an explicit Chromium path when given", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
      executablePath: "/usr/bin/chromium",
    });
    expect(options.executablePath).toBe("/usr/bin/chromium");
  });
});

describe("toOutcome", () => {
  test("passes accounts through on success", () => {
    const outcome = toOutcome({
      success: true,
      accounts: [{ accountNumber: "1", txns: [] }],
    });
    expect(outcome).toEqual({
      ok: true,
      accounts: [{ accountNumber: "1", txns: [] }],
    });
  });

  test("surfaces the scraper's error type and message on failure", () => {
    expect(
      toOutcome({
        success: false,
        errorType: "invalidPassword",
        errorMessage: "bad",
      })
    ).toEqual({
      ok: false,
      errorType: "invalidPassword",
      errorMessage: "bad",
    });
  });

  test("reports a success with no accounts as a failure rather than a silent no-op", () => {
    const outcome = toOutcome({ success: true, accounts: [] });
    expect(outcome.ok).toBe(false);
  });
});

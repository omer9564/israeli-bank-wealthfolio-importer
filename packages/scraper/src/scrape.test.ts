import { describe, expect, mock, test } from "bun:test";
import type { Browser } from "puppeteer";
import {
  buildLaunchOptions,
  buildScraperOptions,
  scrapeProvider,
  toOutcome,
} from "./scrape";

describe("buildScraperOptions", () => {
  test("never combines installments, so each charge lands on its own date", () => {
    const options = buildScraperOptions({ companyId: "isracard" } as never, {
      startDate: new Date("2026-07-01"),
    });
    expect(options.combineInstallments).toBe(false);
  });

  test("carries the scrape-level options through to the scraper", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
      timeoutMs: 5000,
    });
    expect(options.companyId).toBe("hapoalim");
    expect(options.startDate).toEqual(new Date("2026-07-01"));
    expect(options.verbose).toBe(false);
    expect(options.timeout).toBe(5000);
  });

  test("does not carry browser-launch settings; those belong to buildLaunchOptions", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
      executablePath: "/usr/bin/chromium",
    });
    expect(options).not.toHaveProperty("showBrowser");
    expect(options).not.toHaveProperty("args");
    expect(options).not.toHaveProperty("executablePath");
  });
});

describe("buildLaunchOptions", () => {
  test("runs headless with a sandbox-safe argument set", () => {
    const options = buildLaunchOptions({ startDate: new Date("2026-07-01") });
    expect(options.headless).toBe(true);
    expect(options.args).toContain("--no-sandbox");
    expect(options.args).toContain("--disable-dev-shm-usage");
  });

  test("passes an explicit Chromium path when given", () => {
    const options = buildLaunchOptions({
      startDate: new Date("2026-07-01"),
      executablePath: "/usr/bin/chromium",
    });
    expect(options.executablePath).toBe("/usr/bin/chromium");
  });

  test("omits executablePath when none is given", () => {
    const options = buildLaunchOptions({ startDate: new Date("2026-07-01") });
    expect(options).not.toHaveProperty("executablePath");
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

/**
 * Regression coverage for the production leak: a failed scrape used to leave
 * the browser it launched running, keeping Bun's event loop alive forever.
 * These inject a fake launcher so no Chromium is ever started and no bank is
 * ever contacted; the fake browser's `newPage` throws to reproduce the
 * exact failure mode that used to skip the library's own cleanup (a login
 * timeout throwing out of `initialize()`, before `terminate()` ever runs).
 */
describe("scrapeProvider", () => {
  function fakeFailingBrowser(message: string) {
    const close = mock(() => Promise.resolve());
    const browser = {
      newPage: () => {
        throw new Error(message);
      },
      close,
    } as unknown as Browser;
    return { browser, close };
  }

  test("closes the browser it launched even when the scrape throws", async () => {
    const { browser, close } = fakeFailingBrowser("login page never loaded");
    const launch = mock(() => Promise.resolve(browser));

    const outcome = await scrapeProvider(
      { companyId: "hapoalim", credentials: {} } as never,
      { startDate: new Date("2026-07-01") },
      { launch }
    );

    expect(outcome).toEqual({
      ok: false,
      errorType: "exception",
      errorMessage: "login page never loaded",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("still reports the scrape failure even if closing the browser itself fails", async () => {
    const { browser } = fakeFailingBrowser("login page never loaded");
    browser.close = mock(() =>
      Promise.reject(new Error("close failed"))
    ) as unknown as Browser["close"];
    const launch = mock(() => Promise.resolve(browser));

    const outcome = await scrapeProvider(
      { companyId: "hapoalim", credentials: {} } as never,
      { startDate: new Date("2026-07-01") },
      { launch }
    );

    expect(outcome).toEqual({
      ok: false,
      errorType: "exception",
      errorMessage: "login page never loaded",
    });
  });

  test("reports an exception outcome when the browser itself fails to launch", async () => {
    const launch = mock(() =>
      Promise.reject(new Error("failed to launch browser"))
    );

    const outcome = await scrapeProvider(
      { companyId: "hapoalim", credentials: {} } as never,
      { startDate: new Date("2026-07-01") },
      { launch }
    );

    expect(outcome).toEqual({
      ok: false,
      errorType: "exception",
      errorMessage: "failed to launch browser",
    });
  });
});

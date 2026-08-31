import type { ProviderConfig, ScrapedAccount, ScrapeOutcome } from "@ibw/core";
import { createScraper } from "israeli-bank-scrapers";
import puppeteer, { type Browser, type LaunchOptions } from "puppeteer";

export type { ScrapeOutcome } from "@ibw/core";

export interface ScrapeOptions {
  executablePath?: string;
  startDate: Date;
  timeoutMs?: number;
}

/**
 * Launches a browser given the options `buildLaunchOptions` produces. Real
 * runs use `puppeteer.launch` (the default below); tests inject a fake so no
 * Chromium is ever started and no bank is ever contacted.
 */
export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

export interface ScrapeDeps {
  launch?: BrowserLauncher;
}

const defaultLauncher: BrowserLauncher = (options) => puppeteer.launch(options);

export function buildScraperOptions(
  provider: ProviderConfig,
  options: ScrapeOptions
) {
  return {
    companyId: provider.companyId,
    startDate: options.startDate,
    // Each installment is imported on its own charge date, because that is what
    // actually leaves the account that month. Combining would book the whole
    // purchase in month one and misstate every month after.
    combineInstallments: false,
    verbose: false,
    // `defaultTimeout`, NOT `timeout`. The library declares `timeout` in its
    // public options and documents a 30s default, but never reads it —
    // `defaultTimeout` is the one it feeds to page.setDefaultTimeout. Passing
    // `timeout` silently left every navigation on puppeteer's 30s default,
    // which made slow bank sites fail spuriously.
    defaultTimeout: options.timeoutMs ?? 120_000,
  };
}

/**
 * Options for the browser *we* launch. These used to be handed to
 * `createScraper` directly (`showBrowser`, `args`, `executablePath`), which
 * left the library launching and owning the browser: on a thrown scrape it
 * never closed it, leaking Chromium. We launch it ourselves instead so it can
 * always be closed, no matter how the scrape ends.
 */
export function buildLaunchOptions(options: ScrapeOptions): LaunchOptions {
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(options.executablePath === undefined
      ? {}
      : { executablePath: options.executablePath }),
  };
}

export function toOutcome(result: {
  success: boolean;
  accounts?: { accountNumber: string; txns: unknown[] }[];
  errorType?: string;
  errorMessage?: string;
}): ScrapeOutcome {
  if (!result.success) {
    return {
      ok: false,
      errorType: result.errorType ?? "unknown",
      errorMessage:
        result.errorMessage ?? "Scraper reported failure without a message",
    };
  }
  // A "successful" scrape returning nothing means the login silently landed
  // somewhere unexpected. Treating it as success would look like a quiet no-op.
  if (!result.accounts || result.accounts.length === 0) {
    return {
      ok: false,
      errorType: "noAccounts",
      errorMessage: "Scrape succeeded but returned no accounts",
    };
  }
  return { ok: true, accounts: result.accounts as ScrapedAccount[] };
}

/**
 * Owns the browser's whole lifecycle so a failed scrape can never leak it:
 * we launch it, hand it to the scraper via the library's external-browser
 * option (`skipCloseBrowser: true` so the library won't try to close it
 * itself), and close it in `finally` on every path out of this function —
 * a clean success, a scraper-reported failure, or a thrown exception (the
 * case that used to leak: a login timeout throws past the library's own
 * cleanup, which never runs).
 */
export async function scrapeProvider(
  provider: ProviderConfig,
  options: ScrapeOptions,
  deps: ScrapeDeps = {}
): Promise<ScrapeOutcome> {
  const launch = deps.launch ?? defaultLauncher;
  let browser: Browser | undefined;
  try {
    browser = await launch(buildLaunchOptions(options));
    const scraper = createScraper({
      ...buildScraperOptions(provider, options),
      browser,
      skipCloseBrowser: true,
    } as never);
    return toOutcome(
      (await scraper.scrape(provider.credentials as never)) as never
    );
  } catch (error) {
    return {
      ok: false,
      errorType: "exception",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // A failure to close must never mask the real scrape outcome above;
        // the browser process is at worst left for the container to reap.
      }
    }
  }
}

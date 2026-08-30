import type { ProviderConfig, ScrapedAccount, ScrapeOutcome } from "@ibw/core";
import { createScraper } from "israeli-bank-scrapers";

export type { ScrapeOutcome } from "@ibw/core";

export interface ScrapeOptions {
  executablePath?: string;
  startDate: Date;
  timeoutMs?: number;
}

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
    showBrowser: false,
    verbose: false,
    timeout: options.timeoutMs ?? 120_000,
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

export async function scrapeProvider(
  provider: ProviderConfig,
  options: ScrapeOptions
): Promise<ScrapeOutcome> {
  const scraper = createScraper(
    buildScraperOptions(provider, options) as never
  );
  try {
    return toOutcome(
      (await scraper.scrape(provider.credentials as never)) as never
    );
  } catch (error) {
    return {
      ok: false,
      errorType: "exception",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

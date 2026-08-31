export type WealthfolioAccountType = "CASH" | "CREDIT_CARD";

export type ActivityType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "CREDIT"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

/** Mirrors israeli-bank-scrapers' `Transaction`, restated so core stays free of that dependency. */
export interface ScrapedTransaction {
  category?: string;
  chargedAmount: number;
  chargedCurrency?: string;
  date: string;
  description: string;
  identifier?: string | number;
  installments?: { number: number; total: number };
  memo?: string;
  originalAmount: number;
  originalCurrency: string;
  processedDate: string;
  status: "completed" | "pending";
  type: "normal" | "installments";
}

/** Mirrors israeli-bank-scrapers' `TransactionsAccount`. */
export interface ScrapedAccount {
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  currency?: string;
  txns: ScrapedTransaction[];
}

/** Result of one provider scrape. Declared here so `core` and `scraper` share one definition. */
export type ScrapeOutcome =
  | { ok: true; accounts: ScrapedAccount[] }
  | { ok: false; errorType: string; errorMessage: string };

/** The subset of Wealthfolio's `ActivityImport` this importer writes. */
export interface ActivityImport {
  accountId: string;
  activityType: ActivityType;
  amount: number;
  comment: string;
  currency: string;
  date: string;
  duplicateOfId?: string;
  fee: number;
  id?: string;
  isDraft: boolean;
  isValid?: boolean;
  lineNumber?: number;
  subtype?: string;
}

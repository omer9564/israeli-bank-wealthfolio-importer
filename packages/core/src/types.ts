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
  /** Per-field validation messages returned by the server's check pass. */
  errors?: Record<string, string[]>;
  fee: number;
  id?: string;
  isDraft: boolean;
  /**
   * Marks a transfer (or CREDIT) as crossing the tracked-account boundary.
   * The server persists it as `metadata.flow.is_external`, the same field the
   * UI's "External transfer" checkbox sets, so an imported transfer to an
   * account Wealthfolio does not track gets the same net-contribution and
   * flow semantics as a hand-entered one. Only honoured for TRANSFER_IN,
   * TRANSFER_OUT and CREDIT; ignored elsewhere.
   */
  isExternal?: boolean;
  /**
   * Required by the server even for pure cash rows: Wealthfolio's Rust
   * `ActivityImport` declares it `bool`, not `Option<bool>`. The check pass
   * overwrites whatever we send, so we send `false` — we have not validated.
   */
  isValid: boolean;
  lineNumber?: number;
  subtype?: string;
  /**
   * Required by the server (`pub symbol: String`, not `Option`), but an empty
   * string is the documented way to say "pure cash movement": Wealthfolio's
   * `classify_import_activity` maps an empty or cash-placeholder symbol to
   * `CashMovement` — "clear symbol, no asset needed". Omitting the field
   * entirely fails deserialization with a 422.
   */
  symbol: string;
}

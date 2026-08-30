import type { AnchorSkipReason } from "../anchor/balance-anchor";
import { buildAnchor } from "../anchor/balance-anchor";
import type { AccountMapping, Config, ProviderConfig } from "../config/schema";
import { mapTransaction } from "../mapping/map-transaction";
import { DEFAULT_RULES, type MappingRule } from "../mapping/rules";
import type { LinkReport, Sink } from "../sinks/types";
import type { AccountBucket, DetectionResult } from "../transfers/detect";
import { detectCardPayments } from "../transfers/detect";
import type { ActivityImport, ScrapedAccount, ScrapeOutcome } from "../types";

export type ScrapeFn = (
  provider: ProviderConfig,
  startDate: Date
) => Promise<ScrapeOutcome>;

/** Anchor failures worth reporting; the other reasons are ordinary non-events. */
export type ReportableAnchorFailure = Extract<
  AnchorSkipReason,
  "invalidForAccountType" | "nonFiniteBalance"
>;

export interface AccountReport {
  accountNumber: string;
  /** Set when this account's opening balance could not be written. */
  anchorFailure?: ReportableAnchorFailure;
  mapped: boolean;
  /**
   * Rows mapped and handed to the sink. Deliberately NOT called `imported`:
   * the sink may still drop them as duplicates or as rows the server's check
   * pass rejected, so this is an upper bound on what reached Wealthfolio.
   */
  mappedRows: number;
  /** Rows dropped because the scraper's amount was NaN/Infinity — a parse failure. */
  nonFiniteSkipped: number;
  /** Rows dropped because the charge is still pending. Routine. */
  pendingSkipped: number;
  /** Rows dropped because the charge was exactly zero. Benign but worth seeing. */
  zeroAmountSkipped: number;
}

export interface ProviderReport {
  accounts: AccountReport[];
  error?: string;
  id: string;
  ok: boolean;
}

export interface RunReport {
  /** Debits whose declared card account had two or more equally good credits. */
  ambiguousCardPayments: number;
  /** True when no writes went to Wealthfolio (CSV output only). */
  dryRun: boolean;
  finishedAt: string;
  /** Set when `sink.link` threw outright, which strands the legs the same way. */
  linkError?: string;
  /**
   * Declared `cardPayments` targets that were not part of this run at all.
   * Almost always a typo in `wealthfolioAccountId`.
   */
  missingCardAccountIds: string[];
  ok: boolean;
  providers: ProviderReport[];
  startedAt: string;
  totals: {
    duplicates: number;
    imported: number;
    linked: number;
    /** Rows handed to the sink, before the server's own check pass. */
    mappedRows: number;
    nonFiniteSkipped: number;
    /**
     * Transfer pairs detection produced. Every one of them MUST end up linked:
     * see `totals.linked` and `unlinkedPairs`.
     */
    pairsDetected: number;
    pendingSkipped: number;
    /** Rows Wealthfolio's check pass rejected, dropped by the sink. */
    skipped: number;
    unlinkedPairs: number;
    zeroAmountSkipped: number;
  };
  /** False when the sink cannot link at all (CSV), which is not a run failure. */
  transferLinkingSupported: boolean;
}

export interface SyncDeps {
  /** Reported in the summary: a dry run never authenticates, so it cannot anchor. */
  dryRun?: boolean;
  hasActivities(accountId: string): Promise<boolean>;
  now?: () => Date;
  scrape: ScrapeFn;
  sink: Sink;
}

const DAY_MS = 86_400_000;

/** Shared mutable state threaded through one run: bucketed activities-in-progress and the per-account first-sync cache. */
interface SyncState {
  buckets: Map<string, AccountBucket>;
  deps: SyncDeps;
  firstSync: Map<string, boolean>;
  rules: MappingRule[];
}

async function isFirstSync(
  accountId: string,
  state: SyncState
): Promise<boolean> {
  const cached = state.firstSync.get(accountId);
  if (cached !== undefined) {
    return cached;
  }
  const result = !(await state.deps.hasActivities(accountId));
  state.firstSync.set(accountId, result);
  return result;
}

interface MappedAccount {
  activities: ActivityImport[];
  nonFiniteSkipped: number;
  pendingSkipped: number;
  zeroAmountSkipped: number;
}

/**
 * Maps every transaction, keeping a tally of the ones that produced no row.
 * An account whose provider's HTML parse regressed to NaN on every row would
 * otherwise be indistinguishable from an account with no activity.
 */
function mapAccount(
  scraped: ScrapedAccount,
  mapping: AccountMapping,
  state: SyncState
): MappedAccount {
  const context = {
    accountId: mapping.wealthfolioAccountId,
    accountType: mapping.type,
    fallbackCurrency: scraped.currency ?? "ILS",
    rules: state.rules,
  };
  const result: MappedAccount = {
    activities: [],
    nonFiniteSkipped: 0,
    pendingSkipped: 0,
    zeroAmountSkipped: 0,
  };

  for (const txn of scraped.txns) {
    const outcome = mapTransaction(txn, context);
    if (outcome.ok) {
      result.activities.push(outcome.activity);
      continue;
    }
    if (outcome.reason === "pending") {
      result.pendingSkipped += 1;
    } else if (outcome.reason === "zeroAmount") {
      result.zeroAmountSkipped += 1;
    } else {
      result.nonFiniteSkipped += 1;
    }
  }

  return result;
}

/**
 * Maps one scraped account's transactions, buckets them under its Wealthfolio
 * account, and — on a first sync only — adds an opening balance anchor.
 */
async function processAccount(
  scraped: ScrapedAccount,
  mapping: AccountMapping,
  state: SyncState
): Promise<AccountReport> {
  const mapped = mapAccount(scraped, mapping, state);

  const bucket = state.buckets.get(mapping.wealthfolioAccountId) ?? {
    accountId: mapping.wealthfolioAccountId,
    accountType: mapping.type,
    activities: [],
  };
  bucket.activities.push(...mapped.activities);
  state.buckets.set(mapping.wealthfolioAccountId, bucket);

  const report: AccountReport = {
    accountNumber: scraped.accountNumber,
    mapped: true,
    mappedRows: mapped.activities.length,
    nonFiniteSkipped: mapped.nonFiniteSkipped,
    pendingSkipped: mapped.pendingSkipped,
    zeroAmountSkipped: mapped.zeroAmountSkipped,
  };

  const first = await isFirstSync(mapping.wealthfolioAccountId, state);
  if (scraped.balance === undefined || !first) {
    return report;
  }

  const outcome = buildAnchor({
    accountId: mapping.wealthfolioAccountId,
    accountType: mapping.type,
    currency: scraped.currency ?? "ILS",
    scrapedBalance: scraped.balance,
    ...(scraped.balanceDate === undefined
      ? {}
      : { balanceDate: scraped.balanceDate }),
    activities: mapped.activities,
  });

  if (outcome.ok) {
    bucket.activities.push(outcome.anchor);
  } else if (
    outcome.reason === "invalidForAccountType" ||
    outcome.reason === "nonFiniteBalance"
  ) {
    report.anchorFailure = outcome.reason;
  }

  return report;
}

/** Scrapes one provider and processes every account it returned; a scrape failure is reported, not thrown. */
async function processProvider(
  provider: ProviderConfig,
  startDate: Date,
  state: SyncState
): Promise<ProviderReport> {
  const outcome = await state.deps.scrape(provider, startDate);
  if (!outcome.ok) {
    return {
      accounts: [],
      error: `${outcome.errorType}: ${outcome.errorMessage}`,
      id: provider.id,
      ok: false,
    };
  }

  const accounts: AccountReport[] = [];
  for (const scraped of outcome.accounts) {
    const mapping = provider.accounts[scraped.accountNumber];
    if (mapping === undefined) {
      accounts.push({
        accountNumber: scraped.accountNumber,
        mapped: false,
        mappedRows: 0,
        nonFiniteSkipped: 0,
        pendingSkipped: 0,
        zeroAmountSkipped: 0,
      });
      continue;
    }
    accounts.push(await processAccount(scraped, mapping, state));
  }

  return { accounts, id: provider.id, ok: true };
}

function sumAccounts(
  providers: ProviderReport[],
  pick: (account: AccountReport) => number
): number {
  return providers.reduce(
    (total, provider) =>
      total +
      provider.accounts.reduce(
        (subtotal, account) => subtotal + pick(account),
        0
      ),
    0
  );
}

function noDetection(): DetectionResult {
  return { ambiguous: [], missingCardAccount: [], pairs: [] };
}

export async function runSync(
  config: Config,
  deps: SyncDeps
): Promise<RunReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  // Always a trailing window, never a watermark: Israeli card charges post days
  // late with backdated timestamps, and server-side dedup makes rescanning free.
  const startDate = new Date(startedAt.getTime() - config.daysBack * DAY_MS);
  const state: SyncState = {
    buckets: new Map(),
    deps,
    firstSync: new Map(),
    rules: [...config.rules, ...DEFAULT_RULES],
  };

  const providers: ProviderReport[] = [];
  for (const provider of config.providers) {
    providers.push(await processProvider(provider, startDate, state));
  }

  const bucketList = [...state.buckets.values()];
  // Transfer detection MUST run before the buckets are flattened: it can push a
  // synthesized counterpart leg into a bucket's activities array, and a leg added
  // after flattening would never reach the sink.
  const detection = config.linkTransfers
    ? detectCardPayments(bucketList, {
        cardPayments: config.cardPayments,
        windowDays: config.transferWindowDays,
      })
    : noDetection();

  const all = bucketList.flatMap((bucket) => bucket.activities);
  const report = await deps.sink.write(all);

  // Ids MUST be assigned back onto the activities before sink.link runs: ApiSink.link
  // cannot link a pair whose legs lack an `id`, and lineNumber == index in `all`.
  for (const [index, activity] of all.entries()) {
    const id = report.ids.get(index);
    if (id !== undefined) {
      activity.id = id;
    }
  }
  // A throw here has exactly the same consequence as a silent skip — the legs
  // are already written and nothing will net them — so it must not escape as a
  // bare error that loses the summary. Report it as unlinked pairs, with the
  // message, and let the run fail on that.
  let linkReport: LinkReport;
  let linkError: string | undefined;
  try {
    linkReport = await deps.sink.link(detection.pairs);
  } catch (error) {
    linkReport = {
      linked: 0,
      supported: true,
      unlinked: detection.pairs.length,
    };
    linkError = error instanceof Error ? error.message : String(error);
  }

  const nonFiniteSkipped = sumAccounts(
    providers,
    (account) => account.nonFiniteSkipped
  );
  // A pair detected but not linked leaves a synthesized TRANSFER_IN standing
  // alone on a CREDIT_CARD account, which Wealthfolio ignores while it still
  // moves the balance — and the importer is stateless, so nothing will ever
  // undo it. Rows the server's check pass rejected are the other silent
  // nothing-happened case. Both fail the run: a non-zero exit is the only
  // alerting channel this project has.
  const ok =
    providers.every((provider) => provider.ok) &&
    report.skipped === 0 &&
    nonFiniteSkipped === 0 &&
    !(linkReport.supported && linkReport.unlinked > 0);

  return {
    ambiguousCardPayments: detection.ambiguous.length,
    dryRun: deps.dryRun ?? false,
    finishedAt: now().toISOString(),
    missingCardAccountIds: [
      ...new Set(
        detection.missingCardAccount.map((entry) => entry.wealthfolioAccountId)
      ),
    ],
    ...(linkError === undefined ? {} : { linkError }),
    ok,
    providers,
    startedAt: startedAt.toISOString(),
    totals: {
      duplicates: report.duplicates,
      imported: report.imported,
      linked: linkReport.linked,
      mappedRows: sumAccounts(providers, (account) => account.mappedRows),
      nonFiniteSkipped,
      pairsDetected: detection.pairs.length,
      pendingSkipped: sumAccounts(
        providers,
        (account) => account.pendingSkipped
      ),
      skipped: report.skipped,
      unlinkedPairs: linkReport.unlinked,
      zeroAmountSkipped: sumAccounts(
        providers,
        (account) => account.zeroAmountSkipped
      ),
    },
    transferLinkingSupported: linkReport.supported,
  };
}

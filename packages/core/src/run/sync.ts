import { buildAnchor } from "../anchor/balance-anchor";
import type { AccountMapping, Config, ProviderConfig } from "../config/schema";
import { mapTransaction } from "../mapping/map-transaction";
import { DEFAULT_RULES, type MappingRule } from "../mapping/rules";
import type { Sink } from "../sinks/types";
import type { AccountBucket } from "../transfers/detect";
import { detectCardPayments } from "../transfers/detect";
import type { ActivityImport, ScrapedAccount, ScrapeOutcome } from "../types";

export type ScrapeFn = (
  provider: ProviderConfig,
  startDate: Date
) => Promise<ScrapeOutcome>;

export interface AccountReport {
  accountNumber: string;
  imported: number;
  mapped: boolean;
}

export interface ProviderReport {
  accounts: AccountReport[];
  error?: string;
  id: string;
  ok: boolean;
}

export interface RunReport {
  finishedAt: string;
  ok: boolean;
  providers: ProviderReport[];
  startedAt: string;
  totals: {
    imported: number;
    duplicates: number;
    skipped: number;
    linked: number;
  };
  unmatchedCardPayments: number;
}

export interface SyncDeps {
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

/**
 * Maps one scraped account's transactions, buckets them under its Wealthfolio
 * account, and — on a first sync only — adds an opening balance anchor.
 */
async function processAccount(
  scraped: ScrapedAccount,
  mapping: AccountMapping,
  state: SyncState
): Promise<AccountReport> {
  const context = {
    accountId: mapping.wealthfolioAccountId,
    accountType: mapping.type,
    fallbackCurrency: scraped.currency ?? "ILS",
    rules: state.rules,
  };
  const activities = scraped.txns
    .map((txn) => mapTransaction(txn, context))
    .filter((activity): activity is ActivityImport => activity !== null);

  const bucket = state.buckets.get(mapping.wealthfolioAccountId) ?? {
    accountId: mapping.wealthfolioAccountId,
    accountType: mapping.type,
    activities: [],
  };
  bucket.activities.push(...activities);
  state.buckets.set(mapping.wealthfolioAccountId, bucket);

  const first = await isFirstSync(mapping.wealthfolioAccountId, state);
  if (scraped.balance !== undefined && first) {
    const anchor = buildAnchor({
      accountId: mapping.wealthfolioAccountId,
      accountType: mapping.type,
      currency: scraped.currency ?? "ILS",
      scrapedBalance: scraped.balance,
      ...(scraped.balanceDate === undefined
        ? {}
        : { balanceDate: scraped.balanceDate }),
      activities,
    });
    if (anchor !== null) {
      bucket.activities.push(anchor);
    }
  }

  return {
    accountNumber: scraped.accountNumber,
    imported: activities.length,
    mapped: true,
  };
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
        imported: 0,
        mapped: false,
      });
      continue;
    }
    accounts.push(await processAccount(scraped, mapping, state));
  }

  return { accounts, id: provider.id, ok: true };
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
    : { pairs: [], unmatched: [] };

  const all = bucketList.flatMap((bucket) => bucket.activities);
  const report = await deps.sink.write(all);

  // Ids MUST be assigned back onto the activities before sink.link runs: ApiSink.link
  // skips any pair whose legs lack an `id`, and lineNumber == index in `all`.
  for (const [index, activity] of all.entries()) {
    const id = report.ids.get(index);
    if (id !== undefined) {
      activity.id = id;
    }
  }
  const linked = await deps.sink.link(detection.pairs);

  return {
    finishedAt: now().toISOString(),
    ok: providers.every((provider) => provider.ok),
    providers,
    startedAt: startedAt.toISOString(),
    totals: {
      imported: report.imported,
      duplicates: report.duplicates,
      skipped: report.skipped,
      linked,
    },
    unmatchedCardPayments: detection.unmatched.length,
  };
}

import type { ActivityImport, WealthfolioAccountType } from "../types";

export interface AccountBucket {
  accountId: string;
  accountType: WealthfolioAccountType;
  activities: ActivityImport[];
}

export interface CardPaymentRule {
  pattern: string;
  wealthfolioAccountId: string;
}

export interface PairPlan {
  in: ActivityImport;
  out: ActivityImport;
  /** True when the card side reported no matching credit and we created the leg. */
  synthesized: boolean;
}

export interface DetectOptions {
  cardPayments: CardPaymentRule[];
  windowDays: number;
}

/** A bank debit that looked like a declared card payment but was not paired. */
export interface UnpairedDebit {
  debit: ActivityImport;
  /** The `cardPayments` entry's declared target, so the summary can name it. */
  wealthfolioAccountId: string;
}

export interface DetectionResult {
  /**
   * Debits with more than one equally good card-side credit. Deliberate: a
   * wrongly-linked pair is invisible and wrong forever.
   */
  ambiguous: UnpairedDebit[];
  /**
   * Debits whose declared `wealthfolioAccountId` was not among this run's
   * accounts at all. Almost always a config typo — a materially different
   * diagnosis from `ambiguous`, and one the user fixes in a different place.
   */
  missingCardAccount: UnpairedDebit[];
  pairs: PairPlan[];
}

const DAY_MS = 86_400_000;

function findCandidates(
  card: AccountBucket,
  debit: ActivityImport,
  claimed: Set<ActivityImport>,
  windowMs: number
): ActivityImport[] {
  const debitTime = new Date(debit.date).getTime();
  return card.activities.filter(
    (candidate) =>
      !claimed.has(candidate) &&
      candidate.activityType === "CREDIT" &&
      candidate.currency === debit.currency &&
      Math.abs(candidate.amount - debit.amount) < 0.005 &&
      Math.abs(new Date(candidate.date).getTime() - debitTime) <= windowMs
  );
}

/**
 * Resolves one already-located debit against its declared card account.
 * Returns `"ambiguous"` when more than one card credit could match (the
 * caller reports that debit as unmatched); otherwise mutates the matched
 * (or synthesized) legs and returns the resulting pair.
 */
function pairDebit(
  debit: ActivityImport,
  rule: CardPaymentRule,
  card: AccountBucket,
  claimed: Set<ActivityImport>,
  windowMs: number
): PairPlan | "ambiguous" {
  const candidates = findCandidates(card, debit, claimed, windowMs);

  // Linking the wrong leg is invisible; leaving it unlinked merely shows as
  // an expense the user can see and fix. So ambiguity means hands off.
  if (candidates.length > 1) {
    return "ambiguous";
  }

  // NOTE: Wealthfolio's spending classifier (activity_classification.rs)
  // returns InternalTransfer for a transfer only when it carries a
  // source_group_id — which POST /activities/link sets. On a CREDIT_CARD
  // account, an unlinked TRANSFER_IN/TRANSFER_OUT falls through and is
  // Ignored instead of netted. So every leg produced below MUST be linked
  // after import, or the pairing this function exists to do is silently
  // undone — and a synthesized leg that is written but never linked is
  // permanent, because the importer keeps no state to undo it with. That
  // invariant is enforced, not merely documented: `runSync` compares
  // `totals.linked` against `totals.pairsDetected` and fails the run when
  // they disagree.
  debit.activityType = "TRANSFER_OUT";
  debit.subtype = undefined;

  const existing = candidates[0];
  if (existing !== undefined) {
    existing.activityType = "TRANSFER_IN";
    existing.subtype = undefined;
    claimed.add(existing);
    return { out: debit, in: existing, synthesized: false };
  }

  const created: ActivityImport = {
    accountId: rule.wealthfolioAccountId,
    activityType: "TRANSFER_IN",
    date: debit.date,
    amount: debit.amount,
    currency: debit.currency,
    fee: 0,
    comment: `${debit.comment} · תשלום לכרטיס`,
    isDraft: false,
  };
  card.activities.push(created);
  claimed.add(created);
  return { out: debit, in: created, synthesized: true };
}

/**
 * Wealthfolio nets a transfer only when both legs share a `source_group_id`,
 * which `POST /activities/link` sets. So a card payment must become a linked
 * TRANSFER_OUT / TRANSFER_IN pair, or it is counted as spending twice.
 *
 * Israeli card issuers usually report only the individual purchases, leaving the
 * monthly charge visible on the bank side alone. Synthesizing the counterpart is
 * safe here precisely because the user *declared* the target account in
 * `cardPayments` — we are not guessing which account a debit belongs to.
 */
export function detectCardPayments(
  buckets: AccountBucket[],
  options: DetectOptions
): DetectionResult {
  const pairs: PairPlan[] = [];
  const ambiguous: UnpairedDebit[] = [];
  const missingCardAccount: UnpairedDebit[] = [];
  if (options.cardPayments.length === 0) {
    return { ambiguous, missingCardAccount, pairs };
  }

  const byId = new Map(buckets.map((bucket) => [bucket.accountId, bucket]));
  const claimed = new Set<ActivityImport>();
  const windowMs = options.windowDays * DAY_MS;

  for (const bucket of buckets) {
    if (bucket.accountType !== "CASH") {
      continue;
    }

    for (const debit of bucket.activities) {
      if (debit.activityType !== "WITHDRAWAL") {
        continue;
      }

      const rule = options.cardPayments.find((candidate) =>
        debit.comment.toLowerCase().includes(candidate.pattern.toLowerCase())
      );
      if (rule === undefined) {
        continue;
      }

      const card = byId.get(rule.wealthfolioAccountId);
      // A declared card account can legitimately be absent from a given run
      // (a config typo, or a partial run where that card provider wasn't
      // scraped). That's a reportable pairing failure, not a bug to paper
      // over — half-transforming the debit would leave it labeled
      // TRANSFER_OUT with no counterpart anywhere, which reads as "linked"
      // in the UI while actually classifying as spend.
      if (card === undefined) {
        missingCardAccount.push({
          debit,
          wealthfolioAccountId: rule.wealthfolioAccountId,
        });
        continue;
      }

      const outcome = pairDebit(debit, rule, card, claimed, windowMs);
      if (outcome === "ambiguous") {
        ambiguous.push({
          debit,
          wealthfolioAccountId: rule.wealthfolioAccountId,
        });
        continue;
      }
      pairs.push(outcome);
    }
  }

  return { ambiguous, missingCardAccount, pairs };
}

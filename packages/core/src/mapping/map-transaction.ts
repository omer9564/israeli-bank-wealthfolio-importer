import type {
  ActivityImport,
  ScrapedTransaction,
  WealthfolioAccountType,
} from "../types";
import { buildComment } from "./comment";
import type { MappingRule } from "./rules";
import { resolveActivityType } from "./rules";

export { buildComment } from "./comment";

export interface MapContext {
  accountId: string;
  accountType: WealthfolioAccountType;
  fallbackCurrency: string;
  rules: MappingRule[];
}

/**
 * Why a scraped transaction produced no activity. These are counted and
 * reported per provider: `pending` is routine, `nonFiniteAmount` means the
 * scraper's HTML parse produced a number that is not a number, which is a
 * defect the run must surface rather than absorb.
 */
export type MapSkipReason = "pending" | "zeroAmount" | "nonFiniteAmount";

/** Mirrors `ScrapeOutcome`: either the mapped row, or why there isn't one. */
export type MapOutcome =
  | { ok: true; activity: ActivityImport }
  | { ok: false; reason: MapSkipReason };

export function mapTransaction(
  txn: ScrapedTransaction,
  ctx: MapContext
): MapOutcome {
  // Pending charges frequently post at a different amount, and the server's
  // idempotency key includes the amount — importing both would create two rows
  // rather than update one. The overlap window picks them up once they post.
  if (txn.status === "pending") {
    return { ok: false, reason: "pending" };
  }
  // Scraper output reaches core via a compile-time cast, not runtime
  // validation, so a parse miss upstream can hand us NaN/Infinity here despite
  // the declared `number` type. Reject it rather than posting a corrupt
  // amount (NaN serializes to `null`) to Wealthfolio.
  if (!Number.isFinite(txn.chargedAmount)) {
    return { ok: false, reason: "nonFiniteAmount" };
  }
  if (txn.chargedAmount === 0) {
    return { ok: false, reason: "zeroAmount" };
  }

  const isInflow = txn.chargedAmount > 0;
  const { activityType, subtype } = resolveActivityType(
    txn.description,
    isInflow,
    ctx.accountType,
    ctx.rules
  );

  return {
    ok: true,
    activity: {
      accountId: ctx.accountId,
      activityType,
      ...(subtype === undefined ? {} : { subtype }),
      date: txn.date,
      amount: Math.abs(txn.chargedAmount),
      currency: txn.chargedCurrency ?? ctx.fallbackCurrency,
      fee: 0,
      comment: buildComment(txn),
      isDraft: false,
    },
  };
}

import { directionOf, isTypeValidForAccount } from "../mapping/rules";
import type {
  ActivityImport,
  ActivityType,
  WealthfolioAccountType,
} from "../types";

/** Rounding guard: below this the "drift" is float noise, not a real gap. */
const EPSILON = 0.005;

export function netEffect(
  activities: ActivityImport[],
  accountType: WealthfolioAccountType
): number {
  return activities.reduce((total, activity) => {
    const direction = directionOf(activity.activityType, accountType);
    if (direction === "inflow") {
      return total + activity.amount;
    }
    if (direction === "outflow") {
      return total - activity.amount;
    }
    return total;
  }, 0);
}

export interface AnchorInput {
  accountId: string;
  accountType: WealthfolioAccountType;
  activities: ActivityImport[];
  balanceDate?: string;
  /** The scraped account's own currency. Only activities in this currency net against `scrapedBalance`. */
  currency: string;
  scrapedBalance: number;
}

/**
 * Why an account produced no anchor. `alreadyBalanced` and
 * `noActivitiesInCurrency` are ordinary non-events; `nonFiniteBalance` and
 * `invalidForAccountType` mean the account's opening balance is genuinely
 * missing and the run must say so.
 */
export type AnchorSkipReason =
  | "alreadyBalanced"
  | "invalidForAccountType"
  | "nonFiniteBalance"
  | "noActivitiesInCurrency";

export type AnchorOutcome =
  | { ok: true; anchor: ActivityImport }
  | { ok: false; reason: AnchorSkipReason };

/**
 * israeli-bank-scrapers reaches back months at most, so summed transactions never
 * equal the real balance. On an account's FIRST sync Wealthfolio's own balance is
 * zero and we know exactly what we are about to import, so the correction is
 * simply the difference — no valuation lookup needed.
 *
 * Callers must only invoke this on a first sync (see `WealthfolioClient.hasActivities`).
 * Re-anchoring on later runs would fight the transactions and compound drift.
 */
export function buildAnchor(input: AnchorInput): AnchorOutcome {
  // The scraper's reported balance is a plain number with no runtime
  // validation, so an upstream parse miss can hand us NaN/Infinity here
  // despite the declared `number` type — same rationale as the
  // Number.isFinite guard on chargedAmount in mapTransaction. Reject it
  // rather than posting a corrupt amount (NaN serializes to `null`) to
  // Wealthfolio.
  if (!Number.isFinite(input.scrapedBalance)) {
    return { ok: false, reason: "nonFiniteBalance" };
  }

  // The scraped balance is denominated in the account's own currency, so
  // only same-currency activities legitimately net against it — mixing in
  // other currencies would sum unrelated magnitudes as if they were fungible.
  const sameCurrency = input.activities.filter(
    (activity) => activity.currency === input.currency
  );
  const first = sameCurrency[0];
  if (first === undefined) {
    return { ok: false, reason: "noActivitiesInCurrency" };
  }

  const difference =
    input.scrapedBalance - netEffect(sameCurrency, input.accountType);
  if (Math.abs(difference) < EPSILON) {
    return { ok: false, reason: "alreadyBalanced" };
  }

  const activityType: ActivityType = difference > 0 ? "DEPOSIT" : "WITHDRAWAL";
  // An inflow anchor on a CREDIT_CARD would be a DEPOSIT, which Wealthfolio's
  // spending classifier IGNORES on that account type — the row would import
  // cleanly and then be invisible, while carrying zero weight in the very
  // netEffect above that produced it. That happens for any card whose scraped
  // balance is at or above its netted activity, i.e. every paid-off card. The
  // remaining card inflow types (CREDIT, TRANSFER_IN) both mean something
  // specific and wrong here, so there is no correct row to emit: refuse, and
  // let the caller report the account as un-anchored.
  if (!isTypeValidForAccount(activityType, input.accountType)) {
    return { ok: false, reason: "invalidForAccountType" };
  }

  const earliest = sameCurrency.reduce(
    (min, activity) => (activity.date < min ? activity.date : min),
    first.date
  );
  const anchorDate = new Date(
    new Date(earliest).getTime() - 86_400_000
  ).toISOString();
  const label = input.balanceDate ?? earliest.slice(0, 10);

  return {
    ok: true,
    anchor: {
      accountId: input.accountId,
      activityType,
      date: anchorDate,
      amount: Math.abs(difference),
      currency: input.currency,
      fee: 0,
      comment: `Opening balance anchor — ${label}`,
      isDraft: false,
    },
  };
}

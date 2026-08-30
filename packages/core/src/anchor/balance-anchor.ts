import { directionOf } from "../mapping/rules";
import type { ActivityImport, WealthfolioAccountType } from "../types";

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
  scrapedBalance: number;
}

/**
 * israeli-bank-scrapers reaches back months at most, so summed transactions never
 * equal the real balance. On an account's FIRST sync Wealthfolio's own balance is
 * zero and we know exactly what we are about to import, so the correction is
 * simply the difference — no valuation lookup needed.
 *
 * Callers must only invoke this on a first sync (see `WealthfolioClient.hasActivities`).
 * Re-anchoring on later runs would fight the transactions and compound drift.
 */
export function buildAnchor(input: AnchorInput): ActivityImport | null {
  const first = input.activities[0];
  if (first === undefined) {
    return null;
  }

  const difference =
    input.scrapedBalance - netEffect(input.activities, input.accountType);
  if (Math.abs(difference) < EPSILON) {
    return null;
  }

  const earliest = input.activities.reduce(
    (min, activity) => (activity.date < min ? activity.date : min),
    first.date
  );
  const anchorDate = new Date(
    new Date(earliest).getTime() - 86_400_000
  ).toISOString();
  const label = input.balanceDate ?? earliest.slice(0, 10);

  return {
    accountId: input.accountId,
    activityType: difference > 0 ? "DEPOSIT" : "WITHDRAWAL",
    date: anchorDate,
    amount: Math.abs(difference),
    currency: first.currency,
    fee: 0,
    comment: `Opening balance anchor — ${label}`,
    isDraft: false,
  };
}

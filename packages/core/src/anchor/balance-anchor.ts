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
  /**
   * Start of the scrape window. The anchor is dated just before this rather
   * than just before the account's own first row, because providers reach
   * back different distances: a card whose history starts before the bank's
   * first transaction would otherwise sit in a stretch of ledger containing
   * card debt and no cash, showing a negative net worth that never happened.
   * The money was in the account from the window's start regardless of when
   * its first transaction landed.
   */
  windowStart: Date;
}

/**
 * Why an account produced no anchor. `alreadyBalanced`,
 * `noActivitiesInCurrency` and `cardNeedsNoAnchor` are ordinary non-events
 * the run should stay quiet about; `nonFiniteBalance` and
 * `invalidForAccountType` mean a cash account's opening balance is genuinely
 * missing and the run must say so.
 */
export type AnchorSkipReason =
  | "alreadyBalanced"
  | "cardNeedsNoAnchor"
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

  // A credit card is never anchored, and this is not a limitation to work
  // around. The whole formula below assumes the scraped balance equals the
  // opening balance plus everything we imported — true for a bank account,
  // false for a card that settles in full every month, where the issuer
  // reports only the CURRENT CYCLE's charge. Verified against Cal: card 5108
  // reports balance -2,114.51 while a year of its charges sums to -74,757.
  // Anchoring on that difference credited the card ~72,600 of pure fiction.
  // A monthly-settling card whose purchases AND payments are both imported
  // converges on the correct balance unaided — Diners landed on -802.17,
  // matching the issuer exactly, with no anchor at all.
  if (input.accountType === "CREDIT_CARD") {
    return { ok: false, reason: "cardNeedsNoAnchor" };
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

  // The anchor's type has to suit the account. On CASH the opening balance is
  // a DEPOSIT or WITHDRAWAL. On a CREDIT_CARD those are meaningless —
  // Wealthfolio's classifier IGNORES a DEPOSIT there, so the row would import
  // cleanly, stay invisible, and carry zero weight in the very netEffect that
  // produced it. The card equivalent is an EXTERNAL transfer: money arriving
  // from, or going to, somewhere Wealthfolio does not track, which is exactly
  // what an opening balance represents. That is the same thing the UI's
  // "External transfer" checkbox writes.
  const activityType: ActivityType = difference > 0 ? "DEPOSIT" : "WITHDRAWAL";
  if (!isTypeValidForAccount(activityType, input.accountType)) {
    return { ok: false, reason: "invalidForAccountType" };
  }

  const earliest = sameCurrency.reduce(
    (min, activity) => (activity.date < min ? activity.date : min),
    first.date
  );
  const anchorDate = new Date(
    input.windowStart.getTime() - 86_400_000
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
      isValid: false,
      symbol: "",
    },
  };
}

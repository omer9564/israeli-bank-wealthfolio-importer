import type { ActivityType, WealthfolioAccountType } from "../types";

export interface MappingRule {
  activityType: ActivityType;
  /** Case-insensitive substring matched against the transaction description. */
  pattern: string;
  subtype?: string;
}

/**
 * Which activity types move money in or out, per account type. Taken from
 * Wealthfolio's `classify_activity` — on a credit card, INTEREST is a charge
 * rather than income, so direction is not a property of the type alone.
 */
const DIRECTIONS: Record<
  WealthfolioAccountType,
  { inflow: ActivityType[]; outflow: ActivityType[] }
> = {
  CASH: {
    inflow: ["DEPOSIT", "CREDIT", "INTEREST", "TRANSFER_IN"],
    outflow: ["WITHDRAWAL", "FEE", "TAX", "TRANSFER_OUT"],
  },
  CREDIT_CARD: {
    inflow: ["CREDIT", "TRANSFER_IN"],
    outflow: ["WITHDRAWAL", "FEE", "INTEREST", "TRANSFER_OUT"],
  },
};

/** Subtypes that make a CREDIT visible to the spending classifier on a cash account. */
const CASH_CREDIT_SUBTYPES = new Set([
  "BONUS",
  "REFUND",
  "REBATE",
  "REIMBURSEMENT",
]);

export const DEFAULT_RULES: MappingRule[] = [
  { pattern: "ריבית חובה", activityType: "FEE" },
  { pattern: "ריבית", activityType: "INTEREST" },
  { pattern: "עמלת", activityType: "FEE" },
  { pattern: "עמלה", activityType: "FEE" },
  { pattern: "דמי ניהול", activityType: "FEE" },
  { pattern: "דמי כרטיס", activityType: "FEE" },
];

export function directionOf(
  type: ActivityType,
  account: WealthfolioAccountType
): "inflow" | "outflow" | null {
  const table = DIRECTIONS[account];
  if (table.inflow.includes(type)) {
    return "inflow";
  }
  if (table.outflow.includes(type)) {
    return "outflow";
  }
  return null;
}

export function isTypeValidForAccount(
  type: ActivityType,
  account: WealthfolioAccountType,
  subtype?: string
): boolean {
  if (directionOf(type, account) === null) {
    return false;
  }
  if (account === "CASH" && type === "CREDIT") {
    return subtype !== undefined && CASH_CREDIT_SUBTYPES.has(subtype);
  }
  return true;
}

export function resolveActivityType(
  description: string,
  isInflow: boolean,
  account: WealthfolioAccountType,
  rules: MappingRule[]
): { activityType: ActivityType; subtype?: string } {
  const wanted = isInflow ? "inflow" : "outflow";
  const haystack = description.toLowerCase();

  for (const rule of rules) {
    if (!haystack.includes(rule.pattern.toLowerCase())) {
      continue;
    }
    if (directionOf(rule.activityType, account) !== wanted) {
      continue;
    }
    if (!isTypeValidForAccount(rule.activityType, account, rule.subtype)) {
      continue;
    }
    return rule.subtype === undefined
      ? { activityType: rule.activityType }
      : { activityType: rule.activityType, subtype: rule.subtype };
  }

  if (account === "CREDIT_CARD") {
    return isInflow
      ? { activityType: "CREDIT", subtype: "REFUND" }
      : { activityType: "WITHDRAWAL" };
  }
  return isInflow
    ? { activityType: "DEPOSIT" }
    : { activityType: "WITHDRAWAL" };
}

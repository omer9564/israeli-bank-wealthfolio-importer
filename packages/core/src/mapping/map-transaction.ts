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

export function mapTransaction(
  txn: ScrapedTransaction,
  ctx: MapContext
): ActivityImport | null {
  // Pending charges frequently post at a different amount, and the server's
  // idempotency key includes the amount — importing both would create two rows
  // rather than update one. The overlap window picks them up once they post.
  if (txn.status === "pending") {
    return null;
  }
  if (txn.chargedAmount === 0) {
    return null;
  }

  const isInflow = txn.chargedAmount > 0;
  const { activityType, subtype } = resolveActivityType(
    txn.description,
    isInflow,
    ctx.accountType,
    ctx.rules
  );

  return {
    accountId: ctx.accountId,
    activityType,
    ...(subtype === undefined ? {} : { subtype }),
    date: txn.date,
    amount: Math.abs(txn.chargedAmount),
    currency: txn.chargedCurrency ?? ctx.fallbackCurrency,
    fee: 0,
    comment: buildComment(txn),
    isDraft: false,
  };
}

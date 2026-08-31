import type { ScrapedTransaction } from "../types";

/**
 * The comment is the only place the Hebrew merchant string survives, and it is
 * what Wealthfolio's categorization rules match against. The asmachta is
 * appended because it feeds the server's idempotency key, which materially
 * improves dedup stability across reprocessed statements.
 */
export function buildComment(txn: ScrapedTransaction): string {
  const parts: string[] = [txn.description.trim()];

  const memo = txn.memo?.trim();
  if (memo) {
    parts.push(memo);
  }

  const chargedCurrency = txn.chargedCurrency ?? txn.originalCurrency;
  if (txn.originalCurrency !== chargedCurrency) {
    parts.push(`${Math.abs(txn.originalAmount)} ${txn.originalCurrency}`);
  }

  if (txn.installments) {
    parts.push(`תשלום ${txn.installments.number}/${txn.installments.total}`);
  }

  const identifier =
    txn.identifier === undefined ? "" : String(txn.identifier).trim();
  if (identifier) {
    parts.push(`אסמכתא ${identifier}`);
  }

  return parts.join(" · ");
}

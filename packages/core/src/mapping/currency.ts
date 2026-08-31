/**
 * Israeli scrapers are not consistent about currency: Otsar Hahayal and
 * Isracard return ISO 4217 codes, while Cal returns the symbol `₪`.
 * Wealthfolio validates the code and rejects anything else — a whole Cal
 * import was dropped with "Invalid currency code" before this existed.
 */
const ISO_CODE = /^[A-Za-z]{3}$/;

const SYMBOLS: Record<string, string> = {
  "₪": "ILS",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₽": "RUB",
};

/**
 * Maps a scraper-reported currency to an ISO 4217 code where possible.
 *
 * An unrecognised value is passed through untouched rather than guessed at:
 * the server rejects it and now says why, which is a better outcome than
 * silently importing a row under the wrong currency.
 */
export function normalizeCurrency(raw: string): string {
  const trimmed = raw.trim();
  const mapped = SYMBOLS[trimmed];
  if (mapped !== undefined) {
    return mapped;
  }
  // Already a code — normalise case so "ils" does not reach the server.
  if (ISO_CODE.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return trimmed;
}

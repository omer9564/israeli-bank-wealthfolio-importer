import type { Config } from "./config/schema";

const PLACEHOLDER = "[REDACTED]";
/** Below this length a "secret" matches too much ordinary text to be worth masking. */
const MIN_SECRET_LENGTH = 3;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(secrets: string[]): (text: string) => string {
  const usable = [
    ...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH)),
  ];
  if (usable.length === 0) {
    return (text) => text;
  }

  // Longest first, so a secret containing another is masked whole.
  usable.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(usable.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, PLACEHOLDER);
}

export function collectSecrets(config: Config): string[] {
  const secrets: string[] = [config.wealthfolio.password];
  for (const provider of config.providers) {
    for (const value of Object.values(
      provider.credentials as Record<string, unknown>
    )) {
      if (typeof value === "string") {
        secrets.push(value);
      }
    }
  }
  return secrets;
}

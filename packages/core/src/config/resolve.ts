import type { Config } from "./schema";
import { parseConfig } from "./schema";

export const ADDON_ID = "israeli-bank-importer";
export const ADDON_CONFIG_KEY = "config";

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  /** Reads the addon-scoped secret from a running Wealthfolio. */
  fetchRemote?(url: string, password: string): Promise<string | null>;
  readFile(path: string): Promise<string>;
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Configuration from ${source} could not be parsed as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Env wins over the addon secret store, so a GitHub Actions run is always
 * self-describing and never depends on state inside Wealthfolio.
 */
export async function resolveConfig(deps: ResolveDeps): Promise<Config> {
  const { env } = deps;
  let raw: string | null = null;
  let source = "";

  if (env.IBW_CONFIG) {
    raw = env.IBW_CONFIG;
    source = "IBW_CONFIG";
  } else if (env.IBW_CONFIG_PATH) {
    raw = await deps.readFile(env.IBW_CONFIG_PATH);
    source = `IBW_CONFIG_PATH (${env.IBW_CONFIG_PATH})`;
  } else if (
    deps.fetchRemote &&
    env.WEALTHFOLIO_URL &&
    env.WEALTHFOLIO_PASSWORD
  ) {
    raw = await deps.fetchRemote(env.WEALTHFOLIO_URL, env.WEALTHFOLIO_PASSWORD);
    source = "the Wealthfolio addon secret store";
  }

  if (raw === null) {
    throw new Error(
      "No configuration found. Set IBW_CONFIG (inline JSON) or IBW_CONFIG_PATH (a file), " +
        "or configure the importer in Wealthfolio and set WEALTHFOLIO_URL and WEALTHFOLIO_PASSWORD."
    );
  }

  const parsed = parseJson(raw, source) as Record<string, unknown>;
  const overridden =
    env.WEALTHFOLIO_URL && env.WEALTHFOLIO_PASSWORD
      ? {
          ...parsed,
          wealthfolio: {
            url: env.WEALTHFOLIO_URL,
            password: env.WEALTHFOLIO_PASSWORD,
          },
        }
      : parsed;

  return parseConfig(overridden);
}

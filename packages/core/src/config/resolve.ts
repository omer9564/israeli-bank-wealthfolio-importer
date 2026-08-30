import type { Config } from "./schema";
import { parseConfig } from "./schema";

export const ADDON_ID = "israeli-bank-importer";
export const ADDON_CONFIG_KEY = "config";

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  /**
   * Reads the addon-scoped secret from a running Wealthfolio. Returns the
   * config as text, or already-parsed if the server hands back an object.
   */
  fetchRemote?(url: string, password: string): Promise<unknown>;
  readFile(path: string): Promise<string>;
}

/**
 * The parser's own message is NEVER interpolated. On JavaScriptCore a
 * malformed document reports the offending token verbatim — so
 * `{"password": hunter2}`, an ordinary quoting mistake while hand-editing the
 * IBW_CONFIG secret, yields `Unexpected identifier "hunter2"`. That string
 * escapes redaction structurally: the redactor is built from the parsed
 * config, and this error exists precisely because the config did not parse.
 * The source name is the only thing worth saying here, and it contains no
 * user input.
 */
function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Configuration from ${source} is not valid JSON. ` +
        "Check it with a JSON validator; the parser's message is withheld " +
        "because it can quote the offending text, which may be a credential."
    );
  }
}

/**
 * Wraps a read failure so the message carries the errno code and the variable
 * to look at, never the underlying library's rendering of the path.
 */
async function readConfigFile(
  deps: ResolveDeps,
  path: string
): Promise<string> {
  try {
    return await deps.readFile(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "read failed";
    throw new Error(
      `Could not read the configuration file named by IBW_CONFIG_PATH (${code}).`
    );
  }
}

/**
 * Env wins over the addon secret store, so a GitHub Actions run is always
 * self-describing and never depends on state inside Wealthfolio.
 */
export async function resolveConfig(deps: ResolveDeps): Promise<Config> {
  const { env } = deps;

  // A GitHub secret that is missing or mistyped renders as the empty string,
  // not as unset. Treating that the same as unset would silently fall
  // through to a different source, so an empty value must fail loudly and
  // name the variable rather than resolve config from somewhere else.
  if (env.IBW_CONFIG === "") {
    throw new Error("IBW_CONFIG is set but empty.");
  }
  if (env.IBW_CONFIG_PATH === "") {
    throw new Error("IBW_CONFIG_PATH is set but empty.");
  }

  const hasWealthfolioUrl = Boolean(env.WEALTHFOLIO_URL);
  const hasWealthfolioPassword = Boolean(env.WEALTHFOLIO_PASSWORD);
  // The two only ever apply together as an override (see below). Setting
  // just one is never intentional, and silently discarding it would connect
  // with whatever the base config held instead of what was actually set.
  if (hasWealthfolioUrl !== hasWealthfolioPassword) {
    throw new Error(
      hasWealthfolioUrl
        ? "WEALTHFOLIO_URL is set but WEALTHFOLIO_PASSWORD is not; both are required together."
        : "WEALTHFOLIO_PASSWORD is set but WEALTHFOLIO_URL is not; both are required together."
    );
  }

  let raw: unknown = null;
  let source = "";

  if (env.IBW_CONFIG) {
    raw = env.IBW_CONFIG;
    source = "IBW_CONFIG";
  } else if (env.IBW_CONFIG_PATH) {
    raw = await readConfigFile(deps, env.IBW_CONFIG_PATH);
    source = "IBW_CONFIG_PATH";
  } else if (
    deps.fetchRemote &&
    env.WEALTHFOLIO_URL &&
    env.WEALTHFOLIO_PASSWORD
  ) {
    raw = await deps.fetchRemote(env.WEALTHFOLIO_URL, env.WEALTHFOLIO_PASSWORD);
    source = "the Wealthfolio addon secret store";
  }

  if (raw === null || raw === undefined) {
    throw new Error(
      "No configuration found. Set IBW_CONFIG (inline JSON) or IBW_CONFIG_PATH (a file), " +
        "or configure the importer in Wealthfolio and set WEALTHFOLIO_URL and WEALTHFOLIO_PASSWORD."
    );
  }

  // The addon secret store hands back whatever the server stored: a JSON
  // string when the document was stored as text, or an object when it was
  // stored structured. `WealthfolioClient.request` has already parsed the
  // response body, so parsing again here would only work for the string case.
  const parsed = (
    typeof raw === "string" ? parseJson(raw, source) : raw
  ) as Record<string, unknown>;
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

  // IBW_DAYS_BACK is how the Action's `days-back` input reaches config
  // resolution; undefined means the input was never set, not zero.
  const withDaysBack =
    env.IBW_DAYS_BACK === undefined
      ? overridden
      : { ...overridden, daysBack: Number(env.IBW_DAYS_BACK) };

  return parseConfig(withDaysBack);
}

import type { ActivityImport } from "../types";

const SESSION_COOKIE_PATTERN = /(?:^|[;,\s])wf_session=([^;,\s]+)/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
/** An error body is a debugging aid, not a payload: cap what reaches a log. */
const MAX_ERROR_BODY_CHARS = 200;

export interface ImportSummary {
  duplicates: number;
  imported: number;
  skipped: number;
  total: number;
}

export interface ImportResult {
  activities: ActivityImport[];
  importRunId: string;
  summary: ImportSummary;
}

export interface WealthfolioClientOptions {
  fetch?: typeof fetch;
  password: string;
  url: string;
}

/**
 * Wealthfolio's Personal Access Tokens authorize `/mcp` only — `/api/v1` is
 * behind `require_jwt`, which accepts the session cookie or an Authorization
 * header. So: log in with the password, lift the JWT out of the Set-Cookie, and
 * present it as a bearer token.
 */
export class WealthfolioClient {
  private readonly base: string;
  private readonly password: string;
  private readonly doFetch: typeof fetch;
  private token: string | null = null;

  constructor(options: WealthfolioClientOptions) {
    this.base = `${options.url.replace(TRAILING_SLASHES_PATTERN, "")}/api/v1`;
    this.password = options.password;
    this.doFetch = options.fetch ?? fetch;
  }

  async health(): Promise<void> {
    const response = await this.doFetch(`${this.base}/healthz`);
    if (!response.ok) {
      throw new Error(
        `Wealthfolio is not reachable at ${this.base} (healthz returned ${response.status})`
      );
    }
  }

  async login(): Promise<void> {
    const response = await this.doFetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: this.password }),
    });
    if (!response.ok) {
      throw new Error(
        `Wealthfolio login failed (${response.status}). Check WEALTHFOLIO_PASSWORD.`
      );
    }
    const cookie = response.headers.get("set-cookie");
    const token = cookie?.match(SESSION_COOKIE_PATTERN)?.[1];
    if (!token) {
      throw new Error(
        "Wealthfolio login succeeded but returned no session cookie"
      );
    }
    this.token = token;
  }

  /**
   * `echoBody` decides whether a failure quotes the response body. It is off
   * for the addon secret store, whose body IS the configuration document and
   * therefore every bank credential in it. Elsewhere the body is activity
   * data, and a capped excerpt is worth far more than it costs when a self-
   * hosted server rejects an import.
   */
  private async request<T>(
    path: string,
    init: RequestInit,
    options: { echoBody?: boolean; retry?: boolean } = {}
  ): Promise<T> {
    const { echoBody = true, retry = true } = options;
    if (this.token === null) {
      await this.login();
    }

    const response = await this.doFetch(`${this.base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
        authorization: `Bearer ${this.token}`,
      },
    });

    if (response.status === 401 && retry) {
      this.token = null;
      return this.request<T>(path, init, { echoBody, retry: false });
    }
    if (!response.ok) {
      const detail = echoBody
        ? `: ${(await response.text()).slice(0, MAX_ERROR_BODY_CHARS)}`
        : "";
      throw new Error(
        `Wealthfolio request failed with ${response.status} at ${path}${detail}`
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  checkImport(activities: ActivityImport[]): Promise<ActivityImport[]> {
    return this.request<ActivityImport[]>("/activities/import/check", {
      method: "POST",
      body: JSON.stringify({ activities }),
    });
  }

  import(activities: ActivityImport[]): Promise<ImportResult> {
    return this.request<ImportResult>("/activities/import", {
      method: "POST",
      body: JSON.stringify({ activities }),
    });
  }

  async link(activityAId: string, activityBId: string): Promise<void> {
    await this.request("/activities/link", {
      method: "POST",
      body: JSON.stringify({ activityAId, activityBId }),
    });
  }

  async hasActivities(accountId: string): Promise<boolean> {
    // Response shape (`{ data, total }`) is inferred from Wealthfolio's Rust
    // route/request-body definitions, not confirmed against a live server —
    // hence the fallback to `data?.length` if `total` is ever absent.
    const page = await this.request<{ data?: unknown[]; total?: number }>(
      "/activities/search",
      {
        method: "POST",
        body: JSON.stringify({
          accountIdFilter: [accountId],
          page: 1,
          pageSize: 1,
        }),
      }
    );
    return (page.total ?? page.data?.length ?? 0) > 0;
  }

  /**
   * Returns the already-parsed secret: a string when the addon stored the
   * config document as text, an object when it stored it structured. Callers
   * must NOT parse it again — `request` has done that. The endpoint's exact
   * response shape is inferred from Wealthfolio's Rust route definitions, not
   * confirmed against a live server (spec §16 class), which is why the return
   * type stays `unknown` and config validation is what settles it.
   */
  getSecret(addonId: string, key: string): Promise<unknown> {
    const query = new URLSearchParams({ key });
    return this.request<unknown>(
      `/addons/${encodeURIComponent(addonId)}/secrets?${query}`,
      { method: "GET" },
      // The body of this response is the configuration document itself.
      { echoBody: false }
    );
  }
}

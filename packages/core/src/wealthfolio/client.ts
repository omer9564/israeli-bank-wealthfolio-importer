import type { ActivityImport } from "../types";

const SESSION_COOKIE_PATTERN = /(?:^|[;,\s])wf_session=([^;,\s]+)/;
const TRAILING_SLASHES_PATTERN = /\/+$/;

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

  private async request<T>(
    path: string,
    init: RequestInit,
    retry = true
  ): Promise<T> {
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
      return this.request<T>(path, init, false);
    }
    if (!response.ok) {
      throw new Error(
        `Wealthfolio request failed with ${response.status} at ${path}: ${await response.text()}`
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

  getSecret(addonId: string, key: string): Promise<string | null> {
    const query = new URLSearchParams({ key });
    return this.request<string | null>(
      `/addons/${encodeURIComponent(addonId)}/secrets?${query}`,
      { method: "GET" }
    );
  }
}

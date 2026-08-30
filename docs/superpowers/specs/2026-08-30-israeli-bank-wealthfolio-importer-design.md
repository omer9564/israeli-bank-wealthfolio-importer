# Israeli Bank → Wealthfolio Importer — Design

**Date:** 2026-08-30
**Status:** Approved, pending implementation plan

## 1. Purpose

Import transactions from Israeli banks and credit-card issuers into a
self-hosted [Wealthfolio](https://github.com/wealthfolio/wealthfolio)
instance, unattended, on a schedule.

The headline deliverable is a **reusable GitHub Actions workflow**: a user
adds one file to their own repository, supplies secrets, and their Wealthfolio
fills itself. The same engine also runs as a long-lived Docker container for
users who would rather not put bank credentials on GitHub's runners.

Scraping is delegated to
[israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)
(v6.9.0, 18 providers). This project owns everything after the scrape:
normalization, mapping to Wealthfolio's activity model, transfer detection,
balance anchoring, and delivery.

## 2. The constraint that shapes the architecture

The obvious design — a Wealthfolio addon that syncs in-app — is impossible
here, and the reason drives the whole structure.

Wealthfolio addons run in a sandboxed iframe under
`default-src 'none'; connect-src 'none'` (see `SERVER_CSP` /
`ADDON_SANDBOX_CSP` in `apps/server/src/api.rs`), with network access limited
to hosts declared in `manifest.json`. israeli-bank-scrapers drives a headless
Chromium via puppeteer. An addon cannot launch a browser, spawn a process, or
navigate a bank's login form.

The comparable project, [wealthfolio-simplefin-addon](https://github.com/Bubbles840/wealthfolio-simplefin-addon),
does not face this: SimpleFin is a plain HTTP API, so its addon performs the
whole sync and its companion container is *optional*. For Israeli banks the
roles invert:

| Component | Role |
| --- | --- |
| **Addon** | Control panel. Credentials, account mapping, mapping rules, run history, health. Never scrapes. |
| **CLI / container / Action** | The engine. Every scrape happens here. |

**The companion is mandatory, not optional.** The README must say so above the
fold, or users will install the addon and wait for a sync that can never
happen.

## 3. Architecture

A bun workspace monorepo. The package split is forced by section 2: the addon
bundles for a browser sandbox, so it must not transitively reach puppeteer.

| Package | Contents | Runtime |
| --- | --- | --- |
| `packages/core` | Types, mapping, transfer-pair detection, balance anchoring, config schema, Wealthfolio API client, sink interfaces. **Zero puppeteer.** | browser + server |
| `packages/scraper` | israeli-bank-scrapers wrapper, provider registry, normalization | server only |
| `apps/cli` | Runner; entrypoint for the Docker image and the Action | server only |
| `apps/addon` | React control panel on `@wealthfolio/addon-sdk`; imports `core` only | browser |

A lint rule forbids `packages/core` and `apps/addon` from importing
`packages/scraper`, `puppeteer`, or `node:*`. This boundary is load-bearing —
if it breaks, the addon stops building, and the failure is confusing. It gets
a test, not just a convention.

### Data flow

```
providers (config)
   → packages/scraper: israeli-bank-scrapers → ScrapedAccount[]
   → packages/core/mapping: → ActivityImport[]  (+ anchors, + transfer pairs)
   → packages/core/sinks:
        wealthfolio-api → POST /activities/import/check
                        → POST /activities/import
                        → POST /activities/link      (transfer pairs)
        csv             → Wealthfolio-format CSV files
```

## 4. Wealthfolio integration

### 4.1 Authentication

Wealthfolio's Personal Access Tokens cover the `/mcp` endpoint only, **not**
`/api/v1` (`apps/server/src/api/agent_access.rs`). `/api/v1` is JWT-protected
via `auth::require_jwt`, which accepts either the session cookie or an
`Authorization` header.

The client therefore does:

1. `POST /api/v1/auth/login` with `{ "password": "…" }`
2. Capture the JWT from the `Set-Cookie` response header
3. Send it as `Authorization: Bearer <jwt>` on subsequent calls

Tokens default to a 60-minute TTL (`WF_AUTH_TOKEN_TTL_MINUTES`), far longer
than any run. The client re-authenticates once on a 401 and fails otherwise.

`GET /api/v1/healthz` is unauthenticated and is used as a preflight so a
misconfigured URL produces a clear error rather than a login failure.

### 4.2 Import

`/activities/import` requires each row to carry `isValid` and `isDraft`, which
are populated by the **check** pass. The flow is therefore two-phase and both
phases are mandatory:

1. `POST /api/v1/activities/import/check` with `{ activities: ActivityImport[] }`
   — validates, resolves assets, and flags duplicates (`duplicateOfId`)
2. `POST /api/v1/activities/import` with the returned rows

Rows flagged as duplicates are dropped, not force-imported. `forceImport`
stays `false`; there is no legitimate reason for a scheduled sync to override
duplicate detection.

### 4.3 Deduplication — why the sync is stateless

Wealthfolio computes a SHA-256 `idempotency_key` server-side
(`crates/core/src/activities/idempotency.rs`) over account id, normalized
activity type, date (day precision), asset, quantity, unit price, amount,
non-zero fee, currency, provider reference, and normalized description.

Re-importing an identical transaction is a no-op. **The importer keeps no
watermark, cursor, or state file.** Every run rescans a trailing window and
lets the server discard what it already has. This removes an entire class of
bug (corrupt or lost state producing silent gaps) and is what makes the
GitHub Actions path viable without a writable store.

## 5. Mapping

### 5.1 Source shape

`israeli-bank-scrapers` returns `TransactionsAccount[]`:

```ts
{ accountNumber, balance?, balanceDate?, currency?, cardType?, savingsAccount?, txns }
```

and each `Transaction`:

```ts
{ type, identifier?, date, processedDate, originalAmount, originalCurrency,
  chargedAmount, chargedCurrency?, description, memo?, status,
  installments?, category? }
```

Sign convention: `chargedAmount` is negative for outflows, positive for
inflows. Wealthfolio amounts are unsigned magnitudes — direction is carried by
the activity *type*. Every mapping emits `Math.abs(chargedAmount)`.

### 5.2 Account types

Wealthfolio distinguishes `CASH` from `CREDIT_CARD`
(`crates/core/src/accounts/accounts_constants.rs`); `CREDIT_CARD` is a
liability, excluded from performance reporting but included in spending and
net worth. Bank accounts map to `CASH`, card accounts to `CREDIT_CARD`.

### 5.3 Mapping table

Derived from `classify_activity` in
`crates/spending/src/activity_classification.rs`. This is the authoritative
table — the classifier ignores anything not listed, so a wrong choice here
does not error, it silently omits the row from every spending report.

**`CASH` (bank accounts)**

| Condition | Activity type | Classifies as |
| --- | --- | --- |
| `chargedAmount > 0` | `DEPOSIT` | Income |
| `chargedAmount < 0` | `WITHDRAWAL` | Expense |
| Interest credit (matches an `INTEREST` rule) | `INTEREST` | Income |
| Bank fee (matches a `FEE` rule) | `FEE` | Expense |
| Matched card payment (§6) | `TRANSFER_OUT` | Internal transfer |

**`CREDIT_CARD` (card accounts)**

| Condition | Activity type | Classifies as |
| --- | --- | --- |
| `chargedAmount < 0` (purchase) | `WITHDRAWAL` | Expense |
| `chargedAmount > 0` (refund) | `CREDIT` | Expense refund |
| Matched card payment (§6) | `TRANSFER_IN` | Internal transfer |

The two rule-matched rows use the same mechanism as the user rules in §11: an
ordered list of `{ pattern, activityType, subtype? }`, evaluated before the
sign-based fallback, with a built-in default set for common Hebrew bank
phrasings (ריבית, עמלת, דמי ניהול). User rules are appended and win over the
defaults. There is exactly one rule engine in the codebase, not two.

Two traps encoded here, both silent rather than loud:

- On `CREDIT_CARD`, `DEPOSIT` classifies as **Ignored**. A naive
  "inflow → DEPOSIT" rule would drop every card refund from spending reports
  without any error. Card inflows are `CREDIT` or `TRANSFER_IN`, never
  `DEPOSIT`.
- On `CASH`, a bare `CREDIT` is also **Ignored** unless its `subtype` is
  `BONUS`, `REFUND`, `REBATE`, or `REIMBURSEMENT`. The importer never emits a
  subtype-less `CREDIT` on a cash account.

### 5.4 Field mapping

| Wealthfolio | Source |
| --- | --- |
| `accountId` | resolved from the account mapping (§7) |
| `date` | `txn.date` (ISO 8601) |
| `amount` | `Math.abs(txn.chargedAmount)` |
| `currency` | `txn.chargedCurrency ?? account.currency ?? "ILS"` |
| `comment` | `txn.description`, plus `txn.memo`, installment counter, and `identifier` when present |
| `fee` | `0` — Israeli scrapers report fees as separate transactions |
| `isDraft` | `false` |

`comment` is the only place the Hebrew merchant string survives, and it is
what Wealthfolio's categorization rules match against, so its construction is
deliberate and covered by tests. The `identifier` (אסמכתא) is appended because
it feeds the server's idempotency key, materially improving dedup stability.

### 5.5 Pending transactions

`status: pending` transactions are **skipped** in v1.

A pending charge frequently posts at a different amount, and since the
idempotency key includes the amount, importing it twice produces two rows
rather than an update. Correct handling means reconciling in place — matching
the pending row and mutating or deleting it — which needs `PUT /activities`
and `DELETE /activities/{id}` plus stored provider-id state. That is a v1.1
feature; §12 records it. v1 simply waits for the transaction to post, and the
overlap window (§8) guarantees it is picked up.

### 5.6 Installments

`combineInstallments: false`. Each installment is imported on its own charge
date, which is what actually leaves the account that month. The `comment`
carries `תשלום N/M` so the row is legible. Combining them would book the full
purchase amount in month one and misstate every subsequent month.

## 6. Transfer-pair detection

The Israeli case that makes this non-optional: card purchases land on the card
account *and* the monthly חיוב leaves the bank account. Import both without
linking and every shekel is counted twice — once as card spending, once as a
bank withdrawal. Spending totals roughly double.

Wealthfolio nets a pair only when both legs share a `source_group_id`
(`crates/core/src/activities/transfer_pairs.rs`), which
`POST /api/v1/activities/link` sets. Detection:

1. Candidates: a `CASH` outflow and a `CREDIT_CARD` inflow
2. Equal absolute amount, same currency
3. Dates within a configurable window (default 5 days)
4. The bank-side description matches a known issuer pattern
   (ישראכרט, כאל, מקס, לאומי קארד, אמריקן אקספרס, דיינרס, …), extensible via config

On a match both legs are re-typed to `TRANSFER_OUT` / `TRANSFER_IN` and linked
after import. **Ambiguous matches are left unlinked**: where one bank debit
could pair with two card credits, linking the wrong one is invisible while
leaving it unlinked merely shows as an expense the user can fix. This mirrors
the SimpleFin project's stance on ambiguous Amazon matches, and the same logic
applies — a silent wrong answer is worse than a visible imperfect one.

Disabled by `linkTransfers: false` for users who import only bank accounts.

## 7. Configuration

### 7.1 Schema

Zod-validated, in `packages/core`, shared verbatim by CLI and addon:

```jsonc
{
  "wealthfolio": { "url": "http://wealthfolio:8080", "password": "…" },
  "daysBack": 30,
  "linkTransfers": true,
  "transferWindowDays": 5,
  "providers": [
    {
      "id": "my-hapoalim",
      "companyId": "hapoalim",
      "credentials": { "userCode": "…", "password": "…" },
      "accounts": {
        "12-345-678901": { "wealthfolioAccountId": "…", "type": "CASH" }
      }
    }
  ]
}
```

`credentials` is a discriminated union keyed on `companyId`, because
israeli-bank-scrapers' `ScraperCredentials` differs per provider
(`{userCode,password}`, `{username,password}`, `{id,password,card6Digits}`,
`{username,nationalID,password}`, …). Validating this at config-parse time
turns a mid-scrape browser failure into a startup error naming the missing
field.

Accounts absent from `accounts` are skipped and reported. Auto-creating
Wealthfolio accounts is deliberately not done: `accountNumber` is not stable
enough across providers to risk creating duplicates unattended. The addon
offers one-click creation instead, where a human confirms.

### 7.2 Resolution order

1. `IBW_CONFIG` (inline JSON) or `IBW_CONFIG_PATH` (file) — CI and Docker
2. Wealthfolio's addon secret store — companion users who configured via the UI:
   `GET /api/v1/addons/{addonId}/secrets?key=config`, which returns the
   plaintext secret to an authenticated caller
   (`apps/server/src/api/secrets.rs`)

Env wins when both exist. `WEALTHFOLIO_URL` / `WEALTHFOLIO_PASSWORD` override
the `wealthfolio` block so the Action can pass them as discrete secrets.

## 8. Sync behaviour

**Overlap window.** Every run scrapes from `now - daysBack` (default 30), not
from a stored watermark. Israeli card charges routinely post days late with
backdated timestamps; a strict watermark drops them permanently. Server-side
dedup makes the rescan nearly free.

**Balance anchoring.** israeli-bank-scrapers reaches back months at most, so
summed transactions never equal the real balance — without anchoring, every
account is simply wrong. On an account's first sync the importer compares the
scraped `account.balance` against Wealthfolio's computed valuation and writes
one `DEPOSIT` (or `WITHDRAWAL`) for the difference, commented
`Opening balance anchor — <balanceDate>`.

Anchoring is **first-sync only**, detected by the account having no activities
in Wealthfolio. Re-anchoring on every run would fight the transactions and
compound drift. Drift on later runs is reported, never auto-corrected —
inserting silent balance corrections into someone's finances is not something
a cron job should do unasked. The addon surfaces drift with a one-click fix.

## 9. Sinks

**`wealthfolio-api`** (default) — the flow in §4.2, then `/activities/link`
for pairs. Reports `{ imported, skipped, duplicates, errors }` per account.

**`csv`** — writes Wealthfolio's own import columns
(`date,activityType,amount,currency,fee,comment`, matching
`docs/test-data/credit-card-history.csv`), one file per account plus a
`manifest.json`. For desktop users and for `--dry-run` inspection. Since there
is no server to dedup, CSV output is explicitly documented as
"review before importing".

`Sink` is a two-method interface (`write(activities)`, `link(pairs)`), which
is what keeps `core` free of transport concerns and makes the mapping layer
testable without a server.

## 10. Distribution

**Docker image** — `ghcr.io/omer9564/israeli-bank-wealthfolio-importer`,
bun + Chromium baked in, `linux/amd64` and `linux/arm64`, tagged `:latest`,
`:vX.Y.Z`, and `:vX`. Chromium is installed at build time
(`PUPPETEER_SKIP_DOWNLOAD` off during build, `PUPPETEER_EXECUTABLE_PATH` set
at runtime) so no run pays a browser download. Two modes:
`sync` (once, exit) and `daemon` (internal cron; `TZ` defaults to
`Asia/Jerusalem`).

**GitHub Action** — `action.yml` at the repo root, `runs.using: docker`
pointing at the published image, so a run costs a pull rather than an install.

**Reusable workflow** — `.github/workflows/import.yml` with `on: workflow_call`,
a thin wrapper over the action. The user-facing contract:

```yaml
jobs:
  sync:
    uses: omer9564/israeli-bank-wealthfolio-importer/.github/workflows/import.yml@v1
    with:
      days-back: 30
    secrets:
      IBW_CONFIG: ${{ secrets.IBW_CONFIG }}
      WEALTHFOLIO_URL: ${{ secrets.WEALTHFOLIO_URL }}
      WEALTHFOLIO_PASSWORD: ${{ secrets.WEALTHFOLIO_PASSWORD }}
```

Both action and workflow ship because they serve different needs: the workflow
is the one-liner for pure cron, the action slots into a larger job (matrix over
providers, notify-on-failure, gating). The workflow wrapping the action means
one implementation.

Every run writes a summary table to `$GITHUB_STEP_SUMMARY` and exits non-zero
on any provider failure, so a broken scraper surfaces through GitHub's own
failure notification. This is what lets Telegram wait for v1.1.

## 11. The addon

`apps/addon`, on `@wealthfolio/addon-sdk`, contributing a sidebar route.
Responsibilities:

- **Setup** — pick providers, enter credentials, stored via the SDK's secret
  API into Wealthfolio's encrypted storage. Credentials never enter addon
  settings or logs.
- **Mapping** — list accounts seen by the last run, map each to a Wealthfolio
  account or create one.
- **Status** — last run, per-account counts, errors, unmapped-account banner,
  balance drift with a one-click correction.
- **Rules** — description pattern → activity type overrides, which take
  precedence over §5.3.

The engine writes a run-report blob back to the addon secret store; the addon
reads it. That is the entire coupling — no shared database, no direct calls.

The UI states on every screen that a companion or scheduled workflow must be
running. "Sync now" is disabled with that explanation rather than present and
broken.

Permissions declared in `manifest.json`: `accounts` (read/create), `activities`
(read), `secrets`. Network access is not requested — the addon talks only to
its own host.

## 12. Out of scope for v1

- **OTP / 2FA providers** (OneZero, Behatsdaa, some bank flows). Detected at
  config-validation time and rejected with a message naming the provider and
  linking to the tracking issue. The README carries a support matrix. The
  `otpLongTermToken` path and a Telegram relay are the two candidate
  follow-ups.
- **Pending-transaction reconciliation** (§5.5)
- **Telegram notifications** — a `Notifier` interface ships in v1 with a
  console implementation; Telegram is a second implementation, no refactor.
- **Future debits** (`futureMonthsToScrape`, `FutureDebit`) — Israeli cards
  expose upcoming charges; useful for forecasting, not for a ledger.
- **Auto-creating Wealthfolio accounts** from the CLI (§7.1)
- **Investment holdings** — israeli-bank-scrapers returns transactions, not
  securities positions

## 13. Testing

`bun test`. The scraper is never exercised against a live bank in CI.

- **Mapping** — table-driven over recorded `TransactionsAccount` fixtures
  (anonymized, Hebrew descriptions preserved: RTL text in `comment` is a real
  source of bugs). Every row of §5.3 gets a case, including the two silent
  traps.
- **Transfer detection** — matched, ambiguous, near-miss amounts, out-of-window
  dates. Asserts ambiguous cases stay unlinked.
- **Config** — each provider's credential shape accepted; wrong shapes rejected
  with a message naming the field.
- **Sinks** — against a mock Wealthfolio server asserting the check-then-import
  ordering and that duplicates are dropped.
- **Boundary** — `core` and `addon` import graphs contain no puppeteer/`node:*`.
- **Anchoring** — first sync anchors; second does not.

## 14. Security

Bank credentials are the most sensitive thing this project touches, and the
README leads with the tradeoff rather than burying it.

- GitHub-hosted runners see plaintext credentials in memory during a run. The
  docs recommend a **self-hosted runner or the Docker daemon** for anyone
  uncomfortable with that, and explain the actual exposure rather than
  hand-waving.
- Credentials are redacted from all logs and error messages, enforced by a
  redaction layer with a test. Puppeteer failure screenshots are **off by
  default** — they can capture a logged-in bank session.
- `SECURITY.md` with a disclosure contact.
- The image runs as a non-root user, with no network egress requirement beyond
  the banks and the user's Wealthfolio.
- Dependabot on npm, Docker, and Actions. Actions are pinned by SHA.

## 15. Repository CI and OSS readiness

Following the ecsti layout: thin event workflows delegating to reusable ones.

- `.github/workflows/pull-request.yml`, `push.yml` — entry points with
  concurrency groups
- `.github/workflows/node-ci.yml` (`workflow_call`) — matrix per package:
  `bunx ultracite check`, typecheck, `bun test`
- `.github/workflows/docker-build.yml` (`workflow_call`) — buildx, multi-arch,
  build-only on PRs, push to GHCR on main, layer caching
- `.github/workflows/release.yml` — on tag: publish `:vX.Y.Z`, move `:vX` and
  `:latest`, move the `vX` git tag so `@v1` consumers track it
- Biome via ultracite, matching the ecsti toolchain
- MIT license, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates,
  `CODEOWNERS`
- README: what it does, the mandatory-companion warning (§2), a 5-minute
  quickstart, the provider support matrix, the security tradeoff (§14), and a
  worked GitHub Actions example

## 16. Open questions

None blocking. Two to settle during implementation:

1. Whether `POST /activities/link` accepts activity ids returned by
   `/activities/import` directly, or requires a lookup by idempotency key
   first. To be verified against a local server before building §6.
2. Final Docker image size after Chromium. If it exceeds roughly 1 GB,
   evaluate `israeli-bank-scrapers-core` with a system Chromium.

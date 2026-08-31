# Israeli Bank → Wealthfolio Importer

Import transactions from Israeli banks and credit-card issuers into a
self-hosted [Wealthfolio](https://github.com/wealthfolio/wealthfolio)
instance, unattended, on a schedule. Scraping is delegated to
[israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers)
(v6.9.0); this project owns everything after the scrape — normalizing
transactions, mapping them to Wealthfolio's activity model, detecting card
payments so spending isn't counted twice, anchoring account balances, and
delivering the result into Wealthfolio.

## The companion is mandatory

**There is no Wealthfolio addon that can do the scraping, and there never will
be.** Wealthfolio addons run inside a sandboxed iframe with `connect-src
'none'` and no ability to launch a process — they cannot drive a headless
browser. israeli-bank-scrapers drives Israeli bank and card-issuer sites with
puppeteer, which needs an actual Chromium process. That can only run in this
project's Docker container or its GitHub Action — never inside Wealthfolio
itself, in-browser.

A future addon (v2, not built yet) is planned as a control panel only:
credentials, account mapping, run history. It will never scrape. **If you're
looking for an "install and sync" addon experience today, it does not exist —
you need the container or the Action below, running on a schedule, doing the
actual work.**

## Quickstart (GitHub Actions)

No fork required — the workflow below calls this repository's reusable
workflow directly.

1. In your own repository (private is fine), add three
   [secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets):
   - `IBW_CONFIG` — your full configuration as a single line of **plain JSON**
     (start from [`config.example.jsonc`](config.example.jsonc), fill in your
     real values, then strip every comment — the config loader parses plain
     `JSON.parse`, not JSONC).
   - `WEALTHFOLIO_URL` — e.g. `https://wealthfolio.example.com`.
   - `WEALTHFOLIO_PASSWORD` — your Wealthfolio login password.
2. Copy [`examples/sync.yml`](examples/sync.yml) into
   `.github/workflows/sync.yml` in that repository, unchanged.
3. Push. It runs on the schedule already in that file (twice daily, tolerant
   of Israel's DST shift) and on demand via the Actions tab
   (`workflow_dispatch`).

Every run writes a summary table to the workflow's job summary and exits
non-zero when something went wrong, so it shows up as a normal GitHub Actions
failure notification. A run fails if any provider failed to scrape, if
Wealthfolio's own validation rejected rows (which would otherwise mean a run
that imported nothing and still looked green), if a transaction's amount came
back unparsable, or if a detected card-payment pair could not be linked — see
**Card payments and double counting** for why that last one matters. Pending
transactions being skipped is routine and never fails a run.

See **Security** below before deciding whether a GitHub-hosted runner is the
right place to hold your bank credentials.

## Quickstart (Docker)

For running the importer yourself instead of on GitHub's runners:

1. Write your real configuration to `config.json` next to a `compose.yml`
   (again, start from [`config.example.jsonc`](config.example.jsonc) and
   strip the comments — plain JSON only).
2. ```yaml
   # compose.yml
   services:
     ibw:
       image: ghcr.io/omer9564/israeli-bank-wealthfolio-importer:v1
       command: ["daemon"]
       restart: unless-stopped
       environment:
         IBW_CONFIG_PATH: /config/config.json
         TZ: Asia/Jerusalem
       volumes:
         - ./config.json:/config/config.json:ro
   ```
3. `docker compose up -d`

`daemon` mode loops forever, running a sync every `IBW_INTERVAL_HOURS` (default
`12`, accepted range 1–168) and logging each run's summary. Use `command: ["sync"]` instead for a
single run you trigger yourself (e.g. from cron or a systemd timer on the
host).

## Configuration reference

Configuration is validated with the zod schema in
`packages/core/src/config/schema.ts`; that file is authoritative if this
table and the code ever disagree.

### Resolution order

1. `IBW_CONFIG` — the whole config as inline JSON. Used by the GitHub Action.
2. `IBW_CONFIG_PATH` — a path to a JSON file. Used by the Docker quickstart
   above.
3. Wealthfolio's addon secret store, fetched via the Wealthfolio API — this
   path exists in the client and config resolver already, for the future
   addon control panel to write into. There is no addon yet to populate it,
   so in practice you will always use one of the two options above.

Setting `IBW_CONFIG` or `IBW_CONFIG_PATH` to an **empty string** is treated as
a misconfiguration and fails loudly (a mistyped or empty GitHub secret renders
as `""`, not as unset — silently falling through to another source would hide
that mistake). `WEALTHFOLIO_URL` and `WEALTHFOLIO_PASSWORD`, if set, must be
set together; they override the `wealthfolio` block from whichever source was
used above, which is how the GitHub Actions quickstart keeps the URL and
password as their own discrete secrets instead of embedding them in
`IBW_CONFIG`.

### Top-level fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `wealthfolio.url` | string (URL) | — required | Base URL of your Wealthfolio instance. |
| `wealthfolio.password` | string | — required | Your Wealthfolio login password. |
| `daysBack` | positive integer | `30` | Trailing window rescanned every run. No watermark is kept; server-side dedup makes the rescan cheap. |
| `linkTransfers` | boolean | `true` | Whether to detect and link card-payment transfers (see below). |
| `transferWindowDays` | non-negative integer | `5` | Max days apart a bank debit and card credit may be and still pair. |
| `rules` | array of `{ pattern, activityType, subtype? }` | `[]` | Custom description → activity-type overrides, checked before the built-in Hebrew interest/fee rules. |
| `cardPayments` | array of `{ pattern, wealthfolioAccountId }` | `[]` | Declares which bank debits pay off which card account. |
| `providers` | array, at least 1 | — required | See below. |

### Per-provider fields

Each entry in `providers`:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Your own label; used only in logs and the run summary. |
| `companyId` | one of the ids in the support matrix below | Fixes which `credentials` shape is required. |
| `credentials` | object, shape depends on `companyId` | See the support matrix. A wrong shape is rejected at startup, naming the missing field. |
| `accounts` | map of account number → `{ wealthfolioAccountId, type }` | Default `{}`. `type` is `CASH` or `CREDIT_CARD`. An account the scraper returns but that is missing from this map is skipped and reported, never auto-created. |

`activityType` in a custom rule must be one of `DEPOSIT`, `WITHDRAWAL`,
`CREDIT`, `INTEREST`, `FEE`, `TAX`, `TRANSFER_IN`, `TRANSFER_OUT` — see **How
transactions map** for which of these a given account type actually surfaces
in Wealthfolio's spending reports.

### Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `IBW_CONFIG` | config resolution | Inline JSON config (see above). |
| `IBW_CONFIG_PATH` | config resolution | Path to a JSON config file. |
| `WEALTHFOLIO_URL`, `WEALTHFOLIO_PASSWORD` | config resolution | Override `wealthfolio.url` / `wealthfolio.password`; must be set together. |
| `IBW_DAYS_BACK` | config resolution | Overrides `daysBack`. This is how the Action's `days-back` input reaches the CLI. |
| `IBW_DRY_RUN` | CLI | `"true"` writes CSVs to `IBW_OUT_DIR` instead of pushing to Wealthfolio. **Still performs a real bank login and scrape** — see Limitations. |
| `IBW_OUT_DIR` | CLI | Where dry-run CSVs are written. Default `./out`. |
| `IBW_INTERVAL_HOURS` | CLI (`daemon` command) | Hours between runs in daemon mode. Default `12`; must be between 1 and 168. Anything else (including an empty value) fails at startup rather than defaulting, because an unvalidated interval collapses to a continuous scrape loop. |
| `PUPPETEER_EXECUTABLE_PATH` | scraper | Path to the Chromium binary. Set inside the Docker image; you shouldn't need to set this yourself. |
| `GITHUB_STEP_SUMMARY` | CLI | Set automatically by GitHub Actions; when present, the run summary is also appended there. |

## Provider support matrix

18 companies are defined by israeli-bank-scrapers; 16 are supported here. The
other 2 require an interactive OTP/2FA at login, which cannot complete inside
a scheduled, unattended run — they are rejected with an explicit error at
config-parse time rather than failing partway through a browser session.

| `companyId` | Institution | Credential fields | Status |
| --- | --- | --- | --- |
| `hapoalim` | Bank Hapoalim | `userCode`, `password` | ✅ Supported |
| `leumi` | Bank Leumi | `username`, `password` | ✅ Supported |
| `discount` | Discount Bank | `id`, `password`, `num` | ✅ Supported |
| `mercantile` | Mercantile Bank | `id`, `password`, `num` | ✅ Supported |
| `mizrahi` | Mizrahi Bank | `username`, `password` | ✅ Supported |
| `otsarHahayal` | Bank Otsar Hahayal | `username`, `password` | ✅ Supported |
| `union` | Union | `username`, `password` | ✅ Supported |
| `beinleumi` | Beinleumi | `username`, `password` | ✅ Supported |
| `massad` | Massad | `username`, `password` | ✅ Supported |
| `pagi` | Pagi | `username`, `password` | ✅ Supported |
| `yahav` | Bank Yahav | `username`, `nationalID`, `password` | ✅ Supported |
| `visaCal` | Visa Cal | `username`, `password` | ✅ Supported |
| `max` | Max | `username`, `password` | ✅ Supported |
| `isracard` | Isracard | `id`, `password`, `card6Digits` | ✅ Supported |
| `amex` | Amex | `id`, `password`, `card6Digits` | ✅ Supported |
| `beyahadBishvilha` | Beyahad Bishvilha | `id`, `password` | ✅ Supported |
| `oneZero` | One Zero | `email`, `password` — plus an interactive OTP | ❌ Unsupported |
| `behatsdaa` | Behatsdaa | `id`, `password` — plus an interactive OTP | ❌ Unsupported |

Tracking: [issues tagged with OTP-only provider
support](https://github.com/omer9564/israeli-bank-wealthfolio-importer/issues?q=is%3Aissue+OTP)
— open a new issue there if one doesn't already exist for your provider. The
two candidate approaches are israeli-bank-scrapers' `otpLongTermToken` flow
(log in interactively once, reuse the token afterward) and a relay that asks
you for the code at run time; neither ships today.

## How transactions map

Every mapping decision below comes from Wealthfolio's own spending
classifier (`classify_activity`). That classifier silently **ignores**
anything it doesn't recognize for a given account type — a wrong choice here
does not error, it just leaves the transaction invisible in every spending
report while still sitting, imported, in the ledger. The table below is what
this importer actually implements, chosen so that never happens.

**`CASH` (bank accounts)**

| Condition | Activity type | Classifies as |
| --- | --- | --- |
| `chargedAmount > 0` | `DEPOSIT` | Income |
| `chargedAmount < 0` | `WITHDRAWAL` | Expense |
| Interest credit (matches an `INTEREST` rule) | `INTEREST` | Income |
| Bank fee (matches a `FEE` rule) | `FEE` | Expense |
| Matched card payment (see below) | `TRANSFER_OUT` | Internal transfer |

**`CREDIT_CARD` (card accounts)**

| Condition | Activity type | Classifies as |
| --- | --- | --- |
| `chargedAmount < 0` (purchase) | `WITHDRAWAL` | Expense |
| `chargedAmount > 0` (refund) | `CREDIT` | Expense refund |
| Matched card payment (see below) | `TRANSFER_IN` | Internal transfer |

The rule-matched rows (interest, fees) use the same mechanism as the custom
`rules` in your config: an ordered list of `{ pattern, activityType,
subtype? }`, checked before the sign-based fallback, seeded with defaults for
common Hebrew phrasings (ריבית, עמלת, דמי ניהול). Rules you add are appended
and win over those defaults.

Two silent traps this mapping exists specifically to avoid:

- **`DEPOSIT` is never emitted on a `CREDIT_CARD` account.** Wealthfolio's
  classifier treats `DEPOSIT` on a credit card as **Ignored**. A naive
  "positive amount → DEPOSIT" rule would drop every card refund from spending
  reports with no error at all — the row would import successfully and just
  never show up anywhere. Card-side inflows are always mapped to `CREDIT` or
  `TRANSFER_IN`, never `DEPOSIT`.
- **A subtype-less `CREDIT` is never emitted on a `CASH` account.**
  Wealthfolio's classifier also treats a bare `CREDIT` on a cash account as
  **Ignored** — it only counts if the subtype is one of `BONUS`, `REFUND`,
  `REBATE`, or `REIMBURSEMENT`. The importer never produces a `CREDIT` on a
  `CASH` account without one of those subtypes attached.

Other field-level choices worth knowing: `fee` is always `0` (Israeli
scrapers report fees as separate transactions, not as a fee on another one);
`comment` carries the original Hebrew description plus memo, the original
amount and currency when the charge was converted (e.g. `30 USD`, added
whenever `originalCurrency` differs from the currency actually billed),
installment counter (`תשלום N/M`), and the bank's own reference number
(אסמכתא) when present — it's the only place that text survives, and it's what Wealthfolio's
own categorization rules match against; installments are imported on their
own charge dates rather than combined into one lump sum, because that's what
actually leaves the account each month.

## Card payments and double counting

Israeli card purchases land on the card account, and separately, the monthly
חיוב (charge) leaves the linked bank account. **Import both without linking
them and every shekel of card spending is counted twice** — once as a card
purchase, once as a bank withdrawal — roughly doubling every spending total
Wealthfolio reports.

Declare each pairing in `cardPayments`:

```jsonc
"cardPayments": [
  { "pattern": "ישראכרט", "wealthfolioAccountId": "wf-acc-isracard-card" }
]
```

`pattern` is matched against the **bank-side** transaction's `comment` — not
just the raw scraped description, but the same built comment Wealthfolio
ends up seeing (description plus memo, the original amount and currency when
the charge was converted, installment counter, and reference number; see
**How transactions map**). In practice the description is always
a prefix of `comment`, so matching the issuer name as your bank statement
writes it works the same either way: ישראכרט, כאל, מקס, לאומי קארד, אמריקן
אקספרס, דיינרס, …. `wealthfolioAccountId` must be the `CREDIT_CARD` account
that debit pays off, and it must be one of the ids you declared under some
provider's `accounts` — a typo there is rejected at startup rather than
turning into a puzzling "could not be paired" line at the end of a run.

When a bank debit matches a `cardPayments` pattern, the importer looks for a
card-side `CREDIT` of the same amount and currency within `transferWindowDays`
days. There are three possible outcomes:

- **A single card-side credit matches.** Both legs become a linked
  `TRANSFER_OUT` / `TRANSFER_IN` pair, which is what makes Wealthfolio net
  them instead of counting both as spending.
- **More than one card-side credit could match equally well.** The importer
  leaves the debit unlinked rather than guessing — a wrongly-linked pair is
  invisible and wrong forever, while an unlinked transaction just shows up as
  an ordinary expense you can fix by hand.
- **No card-side credit matches at all — the typical case.** Israeli card
  issuers usually report only the individual purchases; the one monthly
  charge that actually leaves the bank account often has no corresponding
  line on the card statement at all. When that happens, the importer
  **creates** a `TRANSFER_IN` activity on the declared card account that was
  never scraped from anywhere — it exists in neither the bank's data nor the
  card issuer's. You'll recognise it in Wealthfolio by its comment, which
  ends in `· תשלום לכרטיס` ("card payment"), on the `CREDIT_CARD` account you
  named in that `cardPayments` entry. This is safe specifically because you
  declared that account yourself — the importer is never guessing which
  account a debit belongs to, only filling in the other half of a transfer
  you already told it exists. Expect to see this on most card payments; it
  is not a bug and not something scraped in error.

Whichever outcome applies, the linking itself has to succeed. Both legs are
imported first and then linked in a second call, and if Wealthfolio returns no
id for one of them — most often because that leg was already present and got
deduplicated — the pair stays unlinked. That is not cosmetic: whichever leg
was written — the synthesized one, or a matched pre-existing card credit —
keeps moving the card balance with nothing netting against it, and because
the importer keeps no state, nothing will ever undo it. So the run **fails**
and the summary names the count, telling you to find the **unlinked**
`TRANSFER_IN` row(s) on the card account whose amount and date match the bank
debit. Some — not all — will have a comment ending in `· תשלום לכרטיס`; that
suffix only marks a row the importer created, so treat it as a hint rather
than the identifying trait, and link or delete the affected rows by hand.

All of this only happens when `linkTransfers` is true (the default). Without
any `cardPayments` entries at all, no linking is attempted and card payments
are not deduplicated — this is only safe if you're importing bank accounts
with no matching card accounts in the same config. `linkTransfers: false`
disables the whole feature explicitly, including the synthesized leg above.

## Balance anchoring

israeli-bank-scrapers reaches back a few months at most, so the transactions
it returns never sum to an account's actual current balance — without
correcting for that, every account Wealthfolio shows would simply be wrong by
whatever happened before the scraper's history starts.

On an account's **first** sync (detected by that Wealthfolio account having no
activities yet), the importer compares the scraped balance against what the
imported transactions alone would produce, and — if they differ by more than
rounding noise — writes one extra `DEPOSIT` or `WITHDRAWAL` row for the
difference, commented `Opening balance anchor — <date>`. You'll see this row
exactly once per account, the first time it syncs; after that, the account
already has activities, so anchoring never runs again for it.

On a `CASH` account the anchor is a `DEPOSIT`, and Wealthfolio's classifier
counts a deposit as **income** — so a first sync books your whole opening
balance as that month's income, and the month a new account is added will look
anomalous in income reports until you scroll past it. On a `CREDIT_CARD`
account the anchor can only ever be a `WITHDRAWAL`: if the correction would
need to go the other way (a paid-off or in-credit card, which is common), the
importer refuses to write it, because the only row that would fit is a
`DEPOSIT`, which Wealthfolio ignores on a card. The run summary says so, once,
naming the account — add the opening balance by hand in Wealthfolio if you
want that account to start from the right number.

Anchoring only ever happens on that first sync. Balance drift on later runs
(a scraper's reported balance disagreeing with Wealthfolio's own running
total) is never auto-corrected — inserting a silent balance adjustment into
someone's finances isn't something a scheduled job should decide on its own.

## Security

Bank credentials are the most sensitive thing this project touches. See
[`SECURITY.md`](SECURITY.md) for the full policy and how to report a
vulnerability; the tradeoff that matters most when deciding where to run this:

**GitHub-hosted runners hold your plaintext bank credentials in memory for the
duration of every run.** GitHub's hosted runners are ephemeral VMs torn down
after the job finishes, but the job itself sees your secrets unencrypted,
same as any process would. If that's not a risk you're willing to accept, run
the Docker container yourself instead (self-hosted runner, or the Docker
quickstart above, or your own scheduler) — the credentials then never leave
infrastructure you control.

Everything else — credential redaction in logs, screenshots being off by
default, the container's non-root user — is documented in `SECURITY.md`.

## Limitations

- **Pending transactions are skipped, not reconciled.** A `pending` charge
  frequently posts at a different final amount, and since Wealthfolio's
  deduplication key includes the amount, importing the same purchase twice
  (once pending, once posted) would create two rows instead of updating one.
  v1 simply waits for it to post — the trailing rescan window (`daysBack`)
  picks it up automatically once it does.
- **Two providers can't run unattended at all** (`oneZero`, `behatsdaa`) —
  see the support matrix above.
- **No investment holdings.** israeli-bank-scrapers returns bank and card
  transactions, not securities positions, so this importer has nothing to
  say about brokerage/investment accounts.
- **`--dry-run` (`IBW_DRY_RUN=true`) still performs a real bank login and
  scrape.** It means "don't write to Wealthfolio" — it launches Chromium and
  authenticates against the actual bank/card site exactly as a normal run
  does, and writes CSVs of what it found instead of importing them. There is
  no flag that skips the scrape itself.
- **Bind-mounted output on native Linux can fail with a permissions error.**
  The image runs as a non-root user (uid 1001). If `./out` doesn't already
  exist on the host when you run something like
  `docker run -e IBW_DRY_RUN=true -v $PWD/out:/app/out ibw:dev`,
  Docker creates it as `root:root` with mode `0755`, and the container user
  can't write into it. Either create the directory yourself first (`mkdir
  out`) and make it writable by uid 1001, or pass `--user $(id -u):$(id -g)`
  on `docker run`. This only affects `IBW_DRY_RUN`'s CSV output — the default
  `sync` and `daemon` paths never write to `/app/out`.
- **The image is large: about 1.77 GB on disk (~457 MB compressed).** That's
  the Debian + Chromium dependency closure needed to actually run the
  scraper. An Alpine base is a possible future reduction, not something this
  version does.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE)

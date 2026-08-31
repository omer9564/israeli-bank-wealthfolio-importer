# Security Policy

This project logs in to your bank and/or credit-card accounts and to your
Wealthfolio instance, unattended, on a schedule. Treat every configured
credential as exactly as sensitive as the bank login itself — because
functionally, it is.

## What a run can access

Every run of the CLI (inside the Docker image, the GitHub Action, or run
directly) has, for its duration:

- The plaintext credentials for every provider in your configuration
  (whatever `israeli-bank-scrapers` needs to log in: user codes, passwords,
  ID numbers, card digits — see the provider support matrix in the README).
- Your Wealthfolio login password, and the short-lived session token it
  obtains with it.
- Outbound network access to whichever bank/card-issuer sites your
  configured providers scrape, and to your Wealthfolio instance's URL.

It does not need, and the code does not request, any network access beyond
that. If you run the container in an environment you control, you can
firewall it to exactly those destinations.

## Where credentials live in memory: the GitHub-hosted-runner tradeoff

**If you use the GitHub Actions quickstart, your plaintext bank credentials
are held in memory by the runner process for the duration of every run.**
GitHub-hosted runners are ephemeral VMs that are destroyed after the job
finishes, and GitHub does not persist the workspace, but for as long as the
job runs, the process executing this importer sees your credentials
unencrypted in memory and as environment variables — the same as any process
that reads a secret would, on any CI system. That is simply what "an
unattended job needs your bank password" means; nothing about this project
makes it safer or riskier than that plain fact.

If that exposure is not something you're comfortable with, don't use
GitHub-hosted runners for this. Two alternatives that keep credentials off of
infrastructure you don't control:

- A **self-hosted GitHub Actions runner**, on hardware you control, running
  the same reusable workflow.
- The **Docker daemon mode** (see the README's Docker quickstart), run on
  your own machine or server.

Both give you the exact same importer; the only difference is who else's
compute your credentials pass through while it runs.

## Redaction

The CLI collects every credential value and the Wealthfolio password
(`packages/core/src/redact.ts`, `collectSecrets` / `createRedactor`, covered
by tests) and redacts every occurrence of each of them, as literal strings,
out of the run summary before it is printed to the console or appended to
`$GITHUB_STEP_SUMMARY`. Provider-level scrape failures are reported through
that same summary, so a login error that happens to echo back a credential is
redacted before it reaches a log anyone can read.

Every path that prints an error — the top-level handler and the daemon's
per-iteration handler included — goes through that redactor, so redaction is
a property of the program rather than of one call site.

**The limit of that guarantee, stated plainly.** The redactor is built *from
the parsed configuration*, so it can only mask secrets it has already been
told about. Anything that fails before the configuration parses is outside
it. Rather than rely on the redactor there, those paths are built so their
messages cannot contain your input at all — with one deliberate exception,
called out below:

- A malformed `IBW_CONFIG` reports only that it is not valid JSON. The
  parser's own message is deliberately discarded, because on this runtime it
  quotes the offending token — `{"password": hunter2}`, an ordinary quoting
  slip, would otherwise print the password in clear. GitHub masks whole
  secret values, not substrings, so that would appear in the job log.
- An unreadable `IBW_CONFIG_PATH` reports the errno (`ENOENT`, `EACCES`) and
  the variable name, not the underlying library's message.
- A failed request to Wealthfolio's addon secret store never quotes the
  response body, because that body *is* the configuration document. Other
  endpoints' error bodies are capped rather than dropped; they carry activity
  data, not credentials.
- Configuration validation errors name the offending field and never echo a
  credential value. One check is the exception: a `cardPayments` entry whose
  `wealthfolioAccountId` names no declared account has that id echoed back
  in the error, so you can tell which entry is wrong. It is a Wealthfolio
  account id, not a secret, so the tradeoff is deliberate.

Before a configuration exists the redactor is still seeded with the values
the environment is known to carry (`WEALTHFOLIO_PASSWORD`, and the raw
`IBW_CONFIG` document), so the two mechanisms overlap rather than leaving a
gap between them.

## Failure screenshots are off by default

`israeli-bank-scrapers` supports an opt-in `storeFailureScreenShotPath`
option that saves a screenshot when a scrape fails, for debugging. This
importer never sets it — a failed scrape produces no screenshot. Do not
enable it yourself unless you understand what it can capture: a screenshot
taken mid-failure can show a page from **inside a logged-in bank session**,
which is a far more direct credential leak than the login fields themselves
if that file is ever copied, uploaded, or committed by mistake.

## Container hardening

The Docker image runs as a dedicated non-root user (`uid 1001`), created
specifically because bank credentials pass through this process and it has
no reason to run as `root`. Dependencies (npm packages, the base image, and
GitHub Actions themselves) are kept current via Dependabot
(`.github/dependabot.yml`, weekly). Every *external* GitHub Action this
repository's own workflows call is pinned to a full commit SHA rather than a
mutable tag. The one exception is unavoidable rather than an oversight:
`.github/workflows/import.yml` calls this project's own composite action as
`omer9564/israeli-bank-wealthfolio-importer@v1` — a repository cannot
reference its own action by the commit SHA of a release that doesn't exist
yet at the point the workflow file is written, so that one reference tracks
the `v1` tag instead.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:
open the **Security** tab → **Report a vulnerability**. That opens a private
draft advisory visible only to the maintainer until a fix is ready, so
details of an exploitable issue are never posted somewhere public before
there's a patch.

If private reporting isn't available on this repository for some reason,
open a regular issue that says only "security issue, please contact me
privately" with no further detail, and the maintainer (@omer9564) will follow
up to arrange a private channel.

Please do not open a public issue with exploit details, proof-of-concept
credentials, or anything that could help someone compromise another user's
bank or Wealthfolio credentials before a fix ships.

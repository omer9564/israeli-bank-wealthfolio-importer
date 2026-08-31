# Contributing

## Setup

```bash
bun install
```

Requires [Bun](https://bun.sh) — see `.node-version` / `package.json`
(`packageManager`) for the pinned version. This is a Bun workspace monorepo:
`packages/core` (mapping, config, sinks — no puppeteer, no `node:*`),
`packages/scraper` (the `israeli-bank-scrapers` wrapper), and `apps/cli` (the
entrypoint used by the Docker image and the Action).

## Before opening a PR

```bash
bun test
bunx ultracite check
bunx tsc --noEmit
```

All three run in CI (`.github/workflows/node-ci.yml`) and must pass. `ultracite
check` lints and format-checks with Biome; run `bunx ultracite fix` to apply
what it can automatically.

`packages/core/src/boundary.test.ts` asserts that no file under `packages/core`
imports `puppeteer`, `israeli-bank-scrapers`, `@ibw/scraper`, or any `node:*`
built-in. That boundary exists because `packages/core` has to be importable
from a browser-sandboxed Wealthfolio addon eventually — breaking it fails this
test, not silently.

## Commit messages

This repository uses [Conventional
Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:`, `ci:`, `test:`, …). Look at `git log` for the existing style before
your first commit.

## Adding or fixing a provider

**New providers never get a test that logs into a real bank.** The scraper is
never exercised against a live site, in CI or otherwise — every provider-level
test works against recorded, anonymized fixtures.

If you're adding support for a company `israeli-bank-scrapers` already knows
about (see its own
[`CompanyTypes`](https://github.com/eshaham/israeli-bank-scrapers)), or fixing
one that's already listed:

1. Add or correct its credential shape in `CREDENTIALS_BY_COMPANY` in
   `packages/core/src/config/schema.ts`. Match the fields
   `israeli-bank-scrapers` actually requires for that company — check its own
   `ScraperCredentials` type, not this project's memory of it.
2. Add a test in `packages/core/src/config/schema.test.ts` asserting the
   correct shape is accepted, and that a wrong shape is rejected with a
   message naming the missing field (see the existing `hapoalim` / `pagi`
   tests for the pattern).
3. If the provider needs its own mapping behavior (a bank-specific fee/interest
   phrasing, an unusual sign convention, etc.), add a table-driven case to
   `packages/core/src/mapping/map-transaction.test.ts` or
   `packages/core/src/mapping/rules.test.ts` using a hand-built
   `ScrapedTransaction` fixture — the same shape `israeli-bank-scrapers`
   returns, typed out by hand with realistic (but fake) Hebrew description
   text. Do not add a fixture containing a real account number, real
   description text copied from an actual statement, or any real credential.
4. If the company requires an interactive OTP/2FA at login, it belongs in
   `OTP_ONLY_COMPANIES` instead, not in the credential map — see the README's
   provider support matrix for why those are rejected rather than supported.

## Reporting bugs / requesting a provider

Use the issue templates — a bug report asks for the provider, your Wealthfolio
version, and **redacted** logs (the run summary already redacts credentials
before it's printed; double-check before pasting anyway). A provider request
is for a company `israeli-bank-scrapers` doesn't support yet upstream, which
is out of this project's control — link the corresponding upstream issue if
one exists.

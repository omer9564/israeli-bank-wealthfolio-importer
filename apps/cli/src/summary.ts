import type { AccountReport, RunReport } from "@ibw/core";

const ANCHOR_FAILURE_TEXT: Record<
  NonNullable<AccountReport["anchorFailure"]>,
  string
> = {
  invalidForAccountType:
    "the only correcting row would be a type Wealthfolio ignores on that " +
    "account (a DEPOSIT on a credit card)",
  nonFiniteBalance: "the scraper reported a balance that is not a number",
};

function renderProviderTable(report: RunReport): string[] {
  const lines = ["| Provider | Status | Mapped rows |", "| --- | --- | --- |"];
  for (const provider of report.providers) {
    const mappedRows = provider.accounts.reduce(
      (total, account) => total + account.mappedRows,
      0
    );
    lines.push(
      `| ${provider.id} | ${provider.ok ? "ok" : "failed"} | ${mappedRows} |`
    );
  }
  return lines;
}

function renderTotals(report: RunReport): string[] {
  const { totals } = report;
  return [
    "",
    `Mapped ${totals.mappedRows} row(s) → imported ${totals.imported}, ` +
      `${totals.duplicates} duplicate(s) already present, ` +
      `${totals.skipped} rejected by Wealthfolio's check, ` +
      `${totals.linked}/${totals.pairsDetected} transfer pair(s) linked.`,
    `Not mapped: ${totals.pendingSkipped} pending, ` +
      `${totals.zeroAmountSkipped} zero-amount, ` +
      `${totals.nonFiniteSkipped} unparsable amount(s).`,
  ];
}

/**
 * The transfer-pair invariant, stated where a user will see it: a detected pair
 * that is not linked means a synthesized card-side leg was written with nothing
 * netting it, so that card payment is counted twice — and the importer keeps no
 * state, so nothing will ever undo it.
 */
function renderTransferWarnings(report: RunReport): string[] {
  const { totals } = report;
  if (totals.unlinkedPairs === 0) {
    return [];
  }
  if (report.transferLinkingSupported) {
    return [
      "",
      ...(report.linkError === undefined
        ? []
        : [`Linking failed outright: ${report.linkError}`, ""]),
      `❌ ${totals.unlinkedPairs} of ${totals.pairsDetected} detected transfer pair(s) ` +
        "could not be linked, because Wealthfolio returned no activity id for at " +
        "least one leg (usually because that leg was already present and was " +
        "deduplicated). Card spending may be double-counted until this is " +
        "resolved: find the unlinked rows on the card account (their comment ends " +
        "in `· תשלום לכרטיס`) and either link or delete them by hand.",
    ];
  }
  return [
    "",
    `⚠️ ${totals.unlinkedPairs} transfer pair(s) were detected but CSV output cannot ` +
      "express linking. Importing these files as they are would count those card " +
      "payments twice — link or remove the card-side legs after importing.",
  ];
}

function renderSkipWarnings(report: RunReport): string[] {
  const lines: string[] = [];
  const { totals } = report;

  if (totals.skipped > 0) {
    lines.push(
      "",
      `❌ Wealthfolio's check pass rejected ${totals.skipped} row(s), which were ` +
        "dropped rather than imported. A stale `wealthfolioAccountId` or an " +
        "unparsable date is the usual cause."
    );
  }
  if (totals.nonFiniteSkipped > 0) {
    lines.push(
      "",
      `❌ ${totals.nonFiniteSkipped} transaction(s) had an amount that is not a ` +
        "finite number and were dropped. That is a scraping/parse failure, not a " +
        "property of the data — please open an issue naming the provider."
    );
  }
  return lines;
}

function renderCardPaymentWarnings(report: RunReport): string[] {
  const lines: string[] = [];

  if (report.missingCardAccountIds.length > 0) {
    lines.push(
      "",
      "⚠️ These `cardPayments` accounts were not part of this run, so the bank " +
        `debits naming them were left unlinked: ${report.missingCardAccountIds.join(", ")}. ` +
        "Check the id for typos, or that the provider owning that card is in this " +
        "configuration and scraped successfully."
    );
  }
  if (report.ambiguousCardPayments > 0) {
    lines.push(
      "",
      `⚠️ ${report.ambiguousCardPayments} card payment(s) had more than one equally ` +
        "good counterpart on the card side and were left unlinked deliberately — " +
        "guessing wrong would be invisible. Link them by hand if they matter."
    );
  }
  return lines;
}

function renderAccountWarnings(report: RunReport): string[] {
  const lines: string[] = [];

  const unmapped = report.providers.flatMap((provider) =>
    provider.accounts
      .filter((account) => !account.mapped)
      .map((account) => account.accountNumber)
  );
  if (unmapped.length > 0) {
    lines.push(
      "",
      `⚠️ Scraped but unmapped (nothing imported): ${unmapped.join(", ")}`
    );
  }

  for (const provider of report.providers) {
    for (const account of provider.accounts) {
      if (account.anchorFailure !== undefined) {
        lines.push(
          "",
          `⚠️ ${provider.id} / ${account.accountNumber} could not be anchored to its ` +
            `scraped balance: ${ANCHOR_FAILURE_TEXT[account.anchorFailure]}. ` +
            "This account's opening balance is missing; add it in Wealthfolio by " +
            "hand. Anchoring is first-sync only, so this will not be retried."
        );
      }
    }
  }
  return lines;
}

export function renderSummary(report: RunReport): string {
  const lines: string[] = [
    "## Wealthfolio import",
    "",
    ...renderProviderTable(report),
    ...renderTotals(report),
    ...renderSkipWarnings(report),
    ...renderTransferWarnings(report),
    ...renderCardPaymentWarnings(report),
    ...renderAccountWarnings(report),
  ];

  if (report.dryRun) {
    lines.push(
      "",
      "ℹ️ Dry run: nothing was written to Wealthfolio. A dry run never " +
        "authenticates, so it cannot tell whether an account is empty — it " +
        "assumes it is not, and therefore **omits the opening-balance anchor** " +
        "a genuine first sync would write. Expect the real run to add one row " +
        "per account that these CSVs do not contain."
    );
  }

  for (const provider of report.providers) {
    if (!provider.ok) {
      lines.push("", `❌ ${provider.id}: ${provider.error}`);
    }
  }

  return lines.join("\n");
}

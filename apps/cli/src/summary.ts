import type { RunReport } from "@ibw/core";

export function renderSummary(report: RunReport): string {
  const lines: string[] = [
    "## Wealthfolio import",
    "",
    "| Provider | Status | Imported |",
    "| --- | --- | --- |",
  ];

  for (const provider of report.providers) {
    const imported = provider.accounts.reduce(
      (total, account) => total + account.imported,
      0
    );
    lines.push(
      `| ${provider.id} | ${provider.ok ? "ok" : "failed"} | ${imported} |`
    );
  }

  lines.push(
    "",
    `Imported ${report.totals.imported}, ${report.totals.duplicates} duplicates skipped, ` +
      `${report.totals.linked} transfers linked.`
  );

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

  if (report.unmatchedCardPayments > 0) {
    lines.push(
      "",
      `⚠️ ${report.unmatchedCardPayments} possible card payment(s) had an ambiguous counterpart ` +
        "and were left unlinked."
    );
  }

  for (const provider of report.providers) {
    if (!provider.ok) {
      lines.push("", `❌ ${provider.id}: ${provider.error}`);
    }
  }

  return lines.join("\n");
}

#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  ApiSink,
  CsvSink,
  collectSecrets,
  createRedactor,
  resolveConfig,
  runSync,
  WealthfolioClient,
} from "@ibw/core";
import { scrapeProvider } from "@ibw/scraper";
import { renderSummary } from "./summary";

const HOUR_MS = 3_600_000;
const UNSAFE_FILENAME_CHARS = /[\\/]/g;

/**
 * CsvSink builds each output filename as `${accountId}.csv` with no sanitization of
 * its own — an account id containing a path separator or a traversal sequence could
 * otherwise escape `outDir`. This is the concrete filesystem writer, so it replaces
 * separators before joining, then re-checks that the resolved path still sits inside
 * `outDir`.
 */
function resolveCsvPath(outDir: string, fileName: string): string {
  const safeName = fileName.replace(UNSAFE_FILENAME_CHARS, "_");
  const resolvedDir = resolve(outDir);
  const target = resolve(resolvedDir, safeName);
  if (target !== resolvedDir && !target.startsWith(`${resolvedDir}${sep}`)) {
    throw new Error(
      `Refusing to write CSV outside the output directory: ${fileName}`
    );
  }
  return target;
}

async function sync(): Promise<number> {
  const config = await resolveConfig({
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    fetchRemote: (url, password) => {
      const client = new WealthfolioClient({ url, password });
      return client.getSecret("israeli-bank-importer", "config");
    },
  });

  const redact = createRedactor(collectSecrets(config));
  const dryRun = process.env.IBW_DRY_RUN === "true";
  const outDir = process.env.IBW_OUT_DIR ?? "./out";

  const client = new WealthfolioClient(config.wealthfolio);
  let sink: ApiSink | CsvSink;

  if (dryRun) {
    await mkdir(outDir, { recursive: true });
    sink = new CsvSink({
      write: (fileName, contents) =>
        writeFile(resolveCsvPath(outDir, fileName), contents, "utf8"),
    });
  } else {
    await client.health();
    await client.login();
    sink = new ApiSink(client);
  }

  const report = await runSync(config, {
    sink,
    scrape: (provider, startDate) =>
      scrapeProvider(provider, {
        startDate,
        ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
          ? {}
          : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
      }),
    hasActivities: (accountId) =>
      dryRun ? Promise.resolve(true) : client.hasActivities(accountId),
  });

  const summary = redact(renderSummary(report));
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, {
      flag: "a",
    });
  }

  // A non-zero exit is what turns a broken scraper into a GitHub failure
  // notification, which is why Telegram can wait for v1.1.
  return report.ok ? 0 : 1;
}

async function daemon(): Promise<number> {
  const intervalHours = Number(process.env.IBW_INTERVAL_HOURS ?? "12");
  for (;;) {
    try {
      await sync();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    // Expressed directly as hours→ms rather than the brief's
    // `(intervalHours * DAY_MS) / 24`, which computes the same value.
    await new Promise((res) => setTimeout(res, intervalHours * HOUR_MS));
  }
}

const command = process.argv[2] ?? "sync";

try {
  process.exitCode = command === "daemon" ? await daemon() : await sync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

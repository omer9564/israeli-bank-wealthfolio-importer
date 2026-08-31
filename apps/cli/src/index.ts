#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  ADDON_CONFIG_KEY,
  ADDON_ID,
  ApiSink,
  CsvSink,
  collectSecrets,
  createRedactor,
  resolveConfig,
  runSync,
  WealthfolioClient,
} from "@ibw/core";
import { scrapeProvider } from "@ibw/scraper";
import { resolveCsvPath } from "./csv-path";
import { intervalHours } from "./interval";
import { renderSummary } from "./summary";

const HOUR_MS = 3_600_000;

/**
 * Every path that prints an error goes through this, so redaction is a
 * property of the program rather than of one call site. It starts as the
 * best redactor available before a config exists — the values env carries
 * that are known to be secret — and is replaced with the config-derived one
 * the moment `resolveConfig` returns.
 *
 * Errors raised BEFORE that point must not be able to contain input in the
 * first place: `parseJson` withholds the parser's message, the config-file
 * read reports only an errno, and the client's secret-store request never
 * echoes its response body. This function is the belt; those are the braces.
 */
let redact: (text: string) => string = (text) => text;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(error: unknown): void {
  console.error(redact(messageOf(error)));
}

/**
 * Known-secret env values, for the window before a config has been parsed.
 * IBW_CONFIG is included whole: it is not a credential itself, but any error
 * that manages to quote the document back is then masked rather than printed.
 */
function bootstrapSecrets(env: Record<string, string | undefined>): string[] {
  return [env.WEALTHFOLIO_PASSWORD, env.IBW_CONFIG].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

async function sync(): Promise<number> {
  redact = createRedactor(bootstrapSecrets(process.env));

  const config = await resolveConfig({
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    fetchRemote: (url, password) => {
      const client = new WealthfolioClient({ url, password });
      return client.getSecret(ADDON_ID, ADDON_CONFIG_KEY);
    },
  });

  redact = createRedactor(collectSecrets(config));
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
    dryRun,
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
  // Validated once, before the first scrape, so a typo fails immediately
  // instead of after a successful run has already happened.
  const hours = intervalHours(process.env.IBW_INTERVAL_HOURS);
  for (;;) {
    try {
      await sync();
    } catch (error) {
      logError(error);
    }
    // Expressed directly as hours→ms rather than the brief's
    // `(intervalHours * DAY_MS) / 24`, which computes the same value.
    await new Promise((res) => setTimeout(res, hours * HOUR_MS));
  }
}

/**
 * `console.log`/`console.error` write to stdout/stderr asynchronously once
 * either is a pipe (true in Docker and in GitHub Actions), so a bare
 * `process.exit()` right after printing the summary can truncate it. A
 * stream's write callbacks fire strictly in order, so writing an empty chunk
 * and waiting for its callback guarantees every write queued ahead of it —
 * the summary, any error text — has already been flushed.
 */
function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

async function flushOutput(): Promise<void> {
  await flushStream(process.stdout);
  await flushStream(process.stderr);
}

const command = process.argv[2] ?? "sync";

if (command === "daemon") {
  // The daemon loop is meant to keep the process alive between syncs, so it
  // gets none of the exit backstop below: `sync()` inside the loop already
  // owns its own cleanup (see packages/scraper/src/scrape.ts), and this
  // outer try/catch only guards startup validation (e.g. a bad
  // IBW_INTERVAL_HOURS) that would otherwise throw past the loop entirely.
  try {
    process.exitCode = await daemon();
  } catch (error) {
    logError(error);
    process.exitCode = 1;
  }
} else {
  let exitCode: number;
  try {
    exitCode = await sync();
  } catch (error) {
    logError(error);
    exitCode = 1;
  }
  await flushOutput();
  // A single scheduled run must never hang past a completed sync — the
  // production incident this guards against was a leaked Chromium process
  // (see packages/scraper/src/scrape.ts) whose open handles kept Bun's event
  // loop alive forever, so `docker run` never returned. Layer 1 fixes the
  // known leak; this is the backstop for any other stray handle: exit
  // explicitly with the computed code instead of trusting the loop to drain.
  process.exit(exitCode);
}

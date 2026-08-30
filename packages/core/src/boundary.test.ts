import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, Glob } from "bun";

/**
 * `packages/core` is bundled into a Wealthfolio addon, which runs in a
 * sandboxed browser iframe. It must therefore reach neither puppeteer nor the
 * scraper nor any Node/Bun runtime API. This is the only enforcement of that
 * constraint, so it checks four things a plain "does it import puppeteer" scan
 * misses: un-prefixed builtins, `require`/dynamic/template forms, the `Bun`
 * and `process` globals, and the package's declared dependencies.
 *
 * Test files are excluded: they are never bundled, and the guard is about what
 * ships. `packages/core/tsconfig.json` draws the same line, with `types: []`
 * so that `Bun` and `process` do not even typecheck in the shipped sources.
 */
const NODE_BUILTINS = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

const FORBIDDEN_PACKAGES = [
  "puppeteer",
  "israeli-bank-scrapers",
  "@ibw/scraper",
];

/**
 * Every module specifier in the file, whatever the syntax: `from "x"`,
 * `import "x"`, `import("x")`, `require("x")`, and the template-literal form
 * of any of them (a substitution keeps whatever literal prefix it had, which
 * is what `node:${name}` needs to stay catchable).
 */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])([^"'`]*)\1/g;

/** `Bun.foo` / `process.foo` as a bare global, not as someone's property. */
const FORBIDDEN_GLOBALS = [
  { name: "Bun", pattern: /(?<![.\w$])Bun\s*\./ },
  { name: "process", pattern: /(?<![.\w$])process\s*\./ },
];

function specifierOffence(specifier: string): string | null {
  if (specifier.startsWith("node:")) {
    return `imports the node builtin "${specifier}"`;
  }
  // Bare (un-prefixed) builtins resolve to the same modules and are just as
  // fatal in a browser bundle, so `import "fs"` must fail exactly like
  // `import "node:fs"`.
  const root = specifier.split("/")[0] ?? "";
  if (NODE_BUILTINS.includes(root)) {
    return `imports the un-prefixed node builtin "${specifier}"`;
  }
  for (const forbidden of FORBIDDEN_PACKAGES) {
    if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
      return `imports "${specifier}"`;
    }
  }
  return null;
}

function offencesIn(source: string): string[] {
  const offences: string[] = [];

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[2] ?? "";
    const offence = specifierOffence(specifier);
    if (offence !== null) {
      offences.push(offence);
    }
  }

  for (const global of FORBIDDEN_GLOBALS) {
    if (global.pattern.test(source)) {
      offences.push(`uses the \`${global.name}\` global`);
    }
  }

  return offences;
}

async function scan(dir: string): Promise<string[]> {
  const glob = new Glob("**/*.ts");
  const offenders: string[] = [];

  for await (const filepath of glob.scan({ cwd: dir, absolute: true })) {
    if (filepath.endsWith(".test.ts")) {
      continue;
    }
    for (const offence of offencesIn(await file(filepath).text())) {
      offenders.push(`${filepath}: ${offence}`);
    }
  }

  return offenders;
}

describe("core import boundary", () => {
  test("no shipped source reaches puppeteer, the scraper, node, or a runtime global", async () => {
    expect(await scan(import.meta.dir)).toEqual([]);
  });

  test.each([
    ['import p from "puppeteer";', 'imports "puppeteer"'],
    ['import "puppeteer/lib/x";', 'imports "puppeteer/lib/x"'],
    ['const p = require("israeli-bank-scrapers");', "israeli-bank-scrapers"],
    ['await import("@ibw/scraper");', "@ibw/scraper"],
    ['import { readFile } from "node:fs/promises";', "node:fs/promises"],
    ['import { readFile } from "fs/promises";', "un-prefixed"],
    ['import fs from "fs";', "un-prefixed"],
    ["await import(`node:fs`);", "node:fs"],
    ["const text = await Bun.file(p).text();", "`Bun` global"],
    ["const home = process.env.HOME;", "`process` global"],
  ])("catches %p", (source, expected) => {
    const offences = offencesIn(source);
    expect(offences.join(" | ")).toContain(expected);
  });

  test.each([
    'import type { Config } from "./config/schema";',
    'import { z } from "zod";',
    "const result = this.process.run();",
    "const value = options.Bun.thing;",
    "// a comment mentioning imports in general",
  ])("does not fire on %p", (source) => {
    expect(offencesIn(source)).toEqual([]);
  });

  test("catches a forbidden import written into a real file on disk", async () => {
    // Written to a temp directory, never into the tracked source tree: an
    // interrupted run used to leave a fixture behind that permanently failed
    // the first test.
    const dir = await mkdtemp(join(tmpdir(), "ibw-boundary-"));
    try {
      await writeFile(join(dir, "offender.ts"), 'import "puppeteer";\n');
      expect(await scan(dir)).toEqual([
        `${join(dir, "offender.ts")}: imports "puppeteer"`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("core dependency closure", () => {
  /** Anything here is bundled into the addon, so the list is exhaustive on purpose. */
  const ALLOWED = ["zod"];

  test("declares no dependency outside the allowlist", async () => {
    const manifest = (await file(
      join(import.meta.dir, "..", "package.json")
    ).json()) as Record<string, Record<string, string> | undefined>;

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...ALLOWED].sort()
    );
    // A node-only package added as a dev or peer dependency would break the
    // addon build just as thoroughly, with no test failure to warn anyone.
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([]);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
    expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
  });

  test("every allowed dependency is itself dependency-free", async () => {
    // The constraint is transitive: an allowlisted package that grows a
    // node-only dependency would reach the bundle just the same.
    for (const name of ALLOWED) {
      const candidates = [
        join(import.meta.dir, "..", "node_modules", name, "package.json"),
        join(
          import.meta.dir,
          "..",
          "..",
          "..",
          "node_modules",
          name,
          "package.json"
        ),
      ];
      let manifest: Record<string, unknown> | null = null;
      for (const candidate of candidates) {
        if (await file(candidate).exists()) {
          manifest = (await file(candidate).json()) as Record<string, unknown>;
          break;
        }
      }
      if (manifest === null) {
        throw new Error(`${name} is not installed; run \`bun install\` first`);
      }
      expect({
        [name]: Object.keys(
          (manifest.dependencies as Record<string, string> | undefined) ?? {}
        ),
      }).toEqual({ [name]: [] });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const FORBIDDEN = [
  /from\s+["']puppeteer["']/,
  /from\s+["']israeli-bank-scrapers/,
  /from\s+["']@ibw\/scraper["']/,
  /from\s+["']node:/,
];

describe("core import boundary", () => {
  test("no source file imports puppeteer, the scraper, or node builtins", async () => {
    const glob = new Glob("**/*.ts");
    const offenders: string[] = [];

    for await (const file of glob.scan({
      cwd: import.meta.dir,
      absolute: true,
    })) {
      if (file.endsWith("boundary.test.ts")) {
        continue;
      }
      const source = await Bun.file(file).text();
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { file, Glob } from "bun";

const FORBIDDEN = [
  // Puppeteer in any import context (from, require, dynamic import, side-effect)
  /(?:from|require|import)\s*[(\s]*["']puppeteer/,
  // israeli-bank-scrapers in any import context
  /(?:from|require|import)\s*[(\s]*["']israeli-bank-scrapers/,
  // @ibw/scraper in any import context
  /(?:from|require|import)\s*[(\s]*["']@ibw\/scraper/,
  // node: builtins in any import context
  /(?:from|require|import)\s*[(\s]*["']node:/,
];

describe("core import boundary", () => {
  test("no source file imports puppeteer, the scraper, or node builtins", async () => {
    const glob = new Glob("**/*.ts");
    const offenders: string[] = [];

    for await (const filepath of glob.scan({
      cwd: import.meta.dir,
      absolute: true,
    })) {
      if (filepath.endsWith("boundary.test.ts")) {
        continue;
      }
      const source = await file(filepath).text();
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${filepath}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("detects when a source file imports forbidden modules", async () => {
    const testFile = `${import.meta.dir}/forbidden.test.temp.ts`;
    const forbiddenContent = `import "puppeteer";\nexport const test = 1;`;

    try {
      // Create a temporary file with a forbidden import
      await file(testFile).write(forbiddenContent);

      // Run the scan on just this directory
      const glob = new Glob("**/*.ts");
      const offenders: string[] = [];

      for await (const filepath of glob.scan({
        cwd: import.meta.dir,
        absolute: true,
      })) {
        if (filepath.endsWith("boundary.test.ts")) {
          continue;
        }
        const source = await file(filepath).text();
        for (const pattern of FORBIDDEN) {
          if (pattern.test(source)) {
            offenders.push(`${filepath}: ${pattern}`);
          }
        }
      }

      // Verify the guard caught the violation
      expect(offenders.some((o) => o.includes("forbidden.test.temp.ts"))).toBe(
        true
      );
    } finally {
      // Clean up even if the test fails
      try {
        await file(testFile).delete();
      } catch {
        // File may not exist, that's fine
      }
    }
  });
});

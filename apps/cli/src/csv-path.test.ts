import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveCsvPath } from "./csv-path";

const OUT_DIR = "/tmp/ibw-out";

describe("resolveCsvPath", () => {
  test("keeps a plain filename inside the output directory", () => {
    expect(resolveCsvPath(OUT_DIR, "acc-1.csv")).toBe(
      resolve(OUT_DIR, "acc-1.csv")
    );
  });

  test("flattens a traversal sequence instead of escaping the directory", () => {
    // CsvSink derives the filename from a Wealthfolio account id, which is
    // config-supplied and never validated as a path component.
    const target = resolveCsvPath(OUT_DIR, "../../escaped.csv");
    expect(target).toBe(resolve(OUT_DIR, ".._.._escaped.csv"));
    expect(target.startsWith(resolve(OUT_DIR))).toBe(true);
  });

  test("flattens a backslash the same way, not only a forward slash", () => {
    const target = resolveCsvPath(OUT_DIR, "..\\..\\escaped.csv");
    expect(target).toBe(resolve(OUT_DIR, ".._.._escaped.csv"));
    expect(target.startsWith(resolve(OUT_DIR))).toBe(true);
  });

  test("resolves the output directory itself relative to the process cwd", () => {
    expect(resolveCsvPath("./out", "a.csv")).toBe(resolve("./out", "a.csv"));
  });
});

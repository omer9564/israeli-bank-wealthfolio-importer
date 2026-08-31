import { resolve, sep } from "node:path";

const UNSAFE_FILENAME_CHARS = /[\\/]/g;

/**
 * CsvSink builds each output filename as `${accountId}.csv` with no sanitization of
 * its own — an account id containing a path separator or a traversal sequence could
 * otherwise escape `outDir`. This is the concrete filesystem writer, so it replaces
 * separators before joining, then re-checks that the resolved path still sits inside
 * `outDir`.
 */
export function resolveCsvPath(outDir: string, fileName: string): string {
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

import { describe, expect, test } from "bun:test";
import { intervalHours } from "./interval";

const NAMES_THE_VARIABLE = /IBW_INTERVAL_HOURS/;

describe("intervalHours", () => {
  test("defaults to 12 hours when the variable is unset", () => {
    expect(intervalHours(undefined)).toBe(12);
  });

  test("accepts a sane value", () => {
    expect(intervalHours("6")).toBe(6);
  });

  // Every one of these produced a 1 ms sleep before validation existed — a
  // continuous scrape loop, i.e. repeated live bank logins with no delay,
  // which is how accounts get locked and IPs blocked.
  test.each([
    "",
    "abc",
    "0",
    "-1",
    "1e9",
  ])("rejects %p rather than looping on bank logins", (value) => {
    expect(() => intervalHours(value)).toThrow(NAMES_THE_VARIABLE);
  });

  test("rejects a value past the upper bound", () => {
    expect(() => intervalHours("169")).toThrow(NAMES_THE_VARIABLE);
  });

  test("accepts the boundaries themselves", () => {
    expect(intervalHours("1")).toBe(1);
    expect(intervalHours("168")).toBe(168);
  });

  test("does not repeat the offending value back", () => {
    // The same empty-env-var hazard resolveConfig guards means this variable
    // can end up holding something meant for another secret.
    const error = (() => {
      try {
        intervalHours("not-a-number-but-maybe-a-password");
        return null;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).not.toContain("not-a-number-but-maybe-a-password");
  });
});

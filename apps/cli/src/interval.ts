const DEFAULT_INTERVAL_HOURS = 12;
const MIN_INTERVAL_HOURS = 1;
/** One week. Beyond this the value is far likelier to be a mistake than an intent. */
const MAX_INTERVAL_HOURS = 168;

/**
 * An unvalidated interval is a live-bank-login loop: `""`, `"abc"`, `"0"`,
 * `"-1"` and `"1e9"` all end up as a 1 ms sleep (the last one because
 * `setTimeout` clamps anything past a 32-bit signed integer back to 1). That
 * is how an account gets locked and an IP blocked, plus a runaway Chromium, so
 * a bad value must stop the daemon rather than silently pick a default.
 *
 * The offending value is deliberately not echoed: the same empty-env-var
 * hazard that `resolveConfig` guards against means this variable can end up
 * holding something that was meant for another secret.
 */
export function intervalHours(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_INTERVAL_HOURS;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < MIN_INTERVAL_HOURS ||
    value > MAX_INTERVAL_HOURS
  ) {
    throw new Error(
      `IBW_INTERVAL_HOURS must be a number of hours between ${MIN_INTERVAL_HOURS} ` +
        `and ${MAX_INTERVAL_HOURS}. Unset it to use the default of ` +
        `${DEFAULT_INTERVAL_HOURS}. (The value is not repeated here in case it ` +
        "was set by mistake from another secret.)"
    );
  }
  return value;
}

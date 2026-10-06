// Refresh policy helpers
// Centralizes parsing and validation for refresh limits and defines the minimum
// scrape size required before replacing existing promises with new results.
export const MIN_PROMISES_TO_REPLACE = 3;

// Converts MIN_PROMISES_TO_REPLACE to a positive integer. Blank or absent
// configuration uses the shared default; invalid values fail configuration
// early instead of silently changing replacement behavior.
export function getPromiseReplacementThreshold(environmentValue) {
  if (environmentValue === undefined || environmentValue.trim() === "") {
    return MIN_PROMISES_TO_REPLACE;
  }

  const parsedValue = Number(environmentValue);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error("MIN_PROMISES_TO_REPLACE must be a positive integer");
  }

  return parsedValue;
}

// Returns whether a scrape count is a valid integer that reaches the threshold;
// callers use false to preserve the previously saved promises.
export function shouldReplacePromises(
  promiseCount,
  threshold = MIN_PROMISES_TO_REPLACE,
) {
  return Number.isInteger(promiseCount) && promiseCount >= threshold;
}

// Parses a refresh setting such as a timeout, concurrency, or limit. Uses the
// supplied fallback only when configuration is absent and rejects values
// outside the positive-integer range or its configured maximum.
export function getPositiveIntegerSetting(
  environmentValue,
  fallbackValue,
  settingName,
  maximumValue = Number.MAX_SAFE_INTEGER,
) {
  if (environmentValue === undefined || environmentValue.trim() === "") {
    return fallbackValue;
  }

  const parsedValue = Number(environmentValue);
  if (
    !Number.isInteger(parsedValue) ||
    parsedValue < 1 ||
    parsedValue > maximumValue
  ) {
    throw new Error(`${settingName} must be an integer between 1 and ${maximumValue}`);
  }

  return parsedValue;
}

// Reserves enough time for one member's scrape, two Congress.gov calls, and
// analysis. The handler may start work only while elapsed time is at or below
// the returned cutoff.
export function getMemberStartCutoffMs(timeBudgetMs, memberTimeoutMs) {
  return timeBudgetMs - memberTimeoutMs - 45_000;
}

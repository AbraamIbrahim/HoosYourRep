// Parses refresh configuration and decides when scraped promises are safe to save.
export const MIN_PROMISES_TO_REPLACE = 3;

// Reads the minimum promise count, using the default when unset.
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

// Determines whether the current scrape meets the configured replacement threshold.
export function shouldReplacePromises(
  promiseCount,
  threshold = MIN_PROMISES_TO_REPLACE,
) {
  return Number.isInteger(promiseCount) && promiseCount >= threshold;
}

// Parses a positive integer setting and enforces its allowed upper bound.
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

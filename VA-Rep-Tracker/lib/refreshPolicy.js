export const MIN_PROMISES_TO_REPLACE = 3;

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

export function shouldReplacePromises(
  promiseCount,
  threshold = MIN_PROMISES_TO_REPLACE,
) {
  return Number.isInteger(promiseCount) && promiseCount >= threshold;
}

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

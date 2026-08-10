/** Resolve a reproducible build timestamp from the standard SOURCE_DATE_EPOCH. */
const MAX_DATE_SECONDS = 8_640_000_000_000;

export function canonicalBuildTimestamp({ sourceDateEpoch = process.env.SOURCE_DATE_EPOCH, now = Date.now() } = {}) {
  if (sourceDateEpoch === undefined) {
    const date = new Date(now);
    if (Number.isNaN(date.getTime())) throw new Error('Current build clock is invalid');
    return date.toISOString();
  }
  if (typeof sourceDateEpoch !== 'string' || !/^[0-9]+$/.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds');
  }
  const seconds = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_DATE_SECONDS) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported JavaScript Date range');
  }
  return new Date(seconds * 1000).toISOString();
}

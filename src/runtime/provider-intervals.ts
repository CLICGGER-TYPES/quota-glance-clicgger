/**
 * Per-provider request throttle. Some quota endpoints dislike frequent polls
 * (the Claude usage endpoint answers 429 with an hour long `retry-after`), so
 * every provider can get its own minimum interval on top of the global refresh
 * interval.
 */
export type ProviderIntervalMap = Record<string, number>;

export const SETTINGS_PROVIDER_INTERVAL = 'provider-interval-minutes';

export const MAX_PROVIDER_INTERVAL_MINUTES = 1440;

/**
 * Sanitizes the dictionary read from the settings: only positive finite
 * numbers survive, clamped to one day.
 */
export function normalizeIntervals(value: unknown): ProviderIntervalMap {
  if (typeof value !== 'object' || value === null)
    return {};

  const result: ProviderIntervalMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const minutes = Number(raw);
    if (Number.isFinite(minutes) && minutes > 0) {
      result[key] = Math.min(
        MAX_PROVIDER_INTERVAL_MINUTES,
        Math.max(1, Math.trunc(minutes)),
      );
    }
  }
  return result;
}

/**
 * The minimum minutes between two requests for this provider; 0 means "no
 * extra throttle, the global refresh interval decides".
 */
export function providerMinimumMinutes(
  intervals: ProviderIntervalMap,
  providerId: string,
): number {
  return intervals[providerId] ?? 0;
}

/**
 * The interval a UI hint should show: the provider's own value when set,
 * otherwise the global refresh interval.
 */
export function effectiveIntervalMinutes(
  intervals: ProviderIntervalMap,
  providerId: string,
  globalMinutes: number,
): number {
  const own = providerMinimumMinutes(intervals, providerId);
  return own > 0 ? own : globalMinutes;
}

/** Writes one provider's override back into the map (0 removes the entry). */
export function withProviderInterval(
  intervals: ProviderIntervalMap,
  providerId: string,
  minutes: number,
): ProviderIntervalMap {
  const next: ProviderIntervalMap = {...intervals};
  if (!Number.isFinite(minutes) || minutes <= 0) {
    delete next[providerId];
    return next;
  }

  next[providerId] = Math.min(
    MAX_PROVIDER_INTERVAL_MINUTES,
    Math.max(1, Math.trunc(minutes)),
  );
  return next;
}

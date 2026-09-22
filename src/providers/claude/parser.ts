import {ProviderRuntimeError} from '../../runtime/errors.js';

export type ClaudeWindowKind = 'session' | 'weekly' | 'scoped';

export interface ClaudeLimitWindow {
  id: string;
  kind: ClaudeWindowKind;
  modelName: string | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export interface ClaudeData {
  planLabel: string | null;
  subscriptionType: string | null;
  limits: ClaudeLimitWindow[];
}

export interface ClaudeUsageOptions {
  rateLimitTier?: string | null;
  subscriptionType?: string | null;
}

const SESSION_KEYS = ['five_hour'] as const;
const WEEKLY_KEYS = ['seven_day'] as const;

/**
 * Top level keys of the usage payload that are not quota windows. The
 * endpoint is undocumented, so unknown object-shaped keys are treated as
 * windows (Anthropic adds model scoped windows such as `seven_day_sonnet`
 * over time) while these known companions are skipped.
 */
const NON_WINDOW_KEYS = new Set([
  'limits',
  'quotas',
  'organization',
  'subscription',
  'rate_limit_tier',
  'extra_usage',
  'spend',
  'seven_day_breakdown',
  'member_dashboard_available',
]);

/**
 * Normalizes the `/api/oauth/usage` payload used by Claude Code's /usage
 * screen. Two shapes are supported: the `limits[]` array (authoritative when
 * present, it also carries model scoped entries) and the older top level
 * window objects.
 */
export function parseClaudeUsageResponse(
  payload: unknown,
  options: ClaudeUsageOptions = {},
): ClaudeData {
  if (!isRecord(payload))
    throw invalidResponse();

  const windows = new Map<string, ClaudeLimitWindow>();
  for (const entry of arrayValue(payload.limits)) {
    const window = readLimitEntry(entry);
    if (window)
      windows.set(window.id, window);
  }
  for (const key of [
    ...SESSION_KEYS,
    ...WEEKLY_KEYS,
    ...extraWindowKeys(payload),
  ]) {
    const window = readTopLevelWindow(key, payload[key]);
    if (window && !windows.has(window.id))
      windows.set(window.id, window);
  }

  const limits = [...windows.values()].sort(compareWindows);
  if (limits.length === 0)
    throw invalidResponse();

  return {
    planLabel: formatPlanLabel(
      options.subscriptionType ?? null,
      options.rateLimitTier ?? null,
    ),
    subscriptionType: options.subscriptionType ?? null,
    limits,
  };
}

export function selectWindow(
  data: ClaudeData,
  kind: ClaudeWindowKind,
): ClaudeLimitWindow | null {
  return data.limits.find(limit => limit.kind === kind) ?? null;
}

/**
 * Short label for the panel, where space is scarce: `5h`, `7d` or the first
 * letters of a model name.
 */
export function compactWindowLabel(window: ClaudeLimitWindow): string {
  if (window.kind === 'session')
    return '5h';
  if (window.kind === 'weekly')
    return '7d';
  return (window.modelName ?? window.id).slice(0, 3);
}

export function formatPlanLabel(
  subscriptionType: string | null,
  rateLimitTier: string | null,
): string | null {
  const subscription = subscriptionType?.trim().toLowerCase() ?? '';
  const tier = rateLimitTier?.trim().toLowerCase() ?? '';

  if (subscription === 'max' || tier.includes('claude_max')) {
    if (tier.includes('20x'))
      return 'Max (20x)';
    if (tier.includes('5x'))
      return 'Max (5x)';
    return 'Max';
  }
  if (subscription === 'free')
    return 'Free';
  if (subscription === 'pro')
    return 'Pro';
  if (subscription.length === 0)
    return null;

  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

function readLimitEntry(entry: unknown): ClaudeLimitWindow | null {
  if (!isRecord(entry))
    return null;

  const percent = numberValue(entry.percent) ?? numberValue(entry.utilization);
  if (percent === null)
    return null;

  const resetsAt = stringOrNull(entry.resets_at) ?? stringOrNull(entry.resetsAt);
  const kind = stringValue(entry.kind);

  if (kind === 'session')
    return createWindow('five_hour', 'session', null, percent, resetsAt);
  if (kind === 'weekly_all')
    return createWindow('seven_day', 'weekly', null, percent, resetsAt);

  const model = readScopeModel(entry);
  if (!model)
    return null;

  return createWindow(`scoped:${model}`, 'scoped', model, percent, resetsAt);
}

function readTopLevelWindow(
  key: string,
  value: unknown,
): ClaudeLimitWindow | null {
  if (!isRecord(value))
    return null;

  const percent = numberValue(value.utilization) ??
    numberValue(value.percent) ??
    numberValue(value.percentage);
  if (percent === null)
    return null;

  const kind: ClaudeWindowKind = key === 'five_hour'
    ? 'session'
    : key === 'seven_day'
      ? 'weekly'
      : 'scoped';

  return createWindow(
    kind === 'scoped' ? `scoped:${modelNameFromKey(key)}` : key,
    kind,
    kind === 'scoped' ? modelNameFromKey(key) : null,
    percent,
    stringOrNull(value.resets_at) ?? stringOrNull(value.resetsAt),
  );
}

function createWindow(
  id: string,
  kind: ClaudeWindowKind,
  modelName: string | null,
  percent: number,
  resetsAt: string | null,
): ClaudeLimitWindow | null {
  // Placeholder entries for model windows that are not in use yet carry 0%
  // and no reset time; showing them would only add noise.
  if (kind === 'scoped' && percent <= 0 && resetsAt === null)
    return null;

  const usedPercent = round(clamp(percent, 0, 100), 1);
  return {
    id,
    kind,
    modelName,
    usedPercent,
    remainingPercent: round(100 - usedPercent, 1),
    resetsAt,
  };
}

function readScopeModel(entry: Record<string, unknown>): string | null {
  if (!isRecord(entry.scope))
    return null;
  if (!isRecord(entry.scope.model))
    return null;
  return nullableString(entry.scope.model.display_name) ??
    nullableString(entry.scope.model.id);
}

function extraWindowKeys(payload: Record<string, unknown>): string[] {
  return Object.keys(payload)
    .filter(key => !NON_WINDOW_KEYS.has(key))
    .filter(key => key !== SESSION_KEYS[0] && key !== WEEKLY_KEYS[0])
    .filter(key => isRecord(payload[key]))
    .sort();
}

function modelNameFromKey(key: string): string {
  const suffix = key.startsWith('seven_day_')
    ? key.slice('seven_day_'.length)
    : key;
  return suffix
    .split(/[_-]+/)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function compareWindows(
  left: ClaudeLimitWindow,
  right: ClaudeLimitWindow,
): number {
  const rank: Record<ClaudeWindowKind, number> = {
    session: 0,
    weekly: 1,
    scoped: 2,
  };
  const difference = rank[left.kind] - rank[right.kind];
  return difference !== 0 ? difference : left.id.localeCompare(right.id);
}

function invalidResponse(): ProviderRuntimeError {
  return new ProviderRuntimeError(
    'invalid-response',
    'Claude returned no supported usage limits',
    {retryable: false},
  );
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text.length > 0 ? text : null;
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text.length > 0 ? text : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

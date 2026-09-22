import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ProviderRuntimeError} from './errors.js';

/**
 * The credential file Claude Code owns. Quota Glance only ever reads it and
 * never writes it back: session renewal is delegated to the Claude CLI (see
 * claude-auth.ts), which keeps ownership of the client identity, the refresh
 * token rotation and the file format.
 */
export interface ClaudeCredential {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export function claudeCredentialPath(): string {
  return GLib.build_filenamev([
    GLib.get_home_dir(),
    '.claude',
    '.credentials.json',
  ]);
}

export function parseClaudeCredential(contents: string): ClaudeCredential {
  let payload: unknown;
  try {
    payload = JSON.parse(contents) as unknown;
  } catch (caught) {
    throw new ProviderRuntimeError(
      'invalid-response',
      'The Claude Code credentials file is not valid JSON',
      {cause: caught, retryable: false},
    );
  }

  if (!isRecord(payload) || !isRecord(payload.claudeAiOauth)) {
    throw new ProviderRuntimeError(
      'invalid-response',
      'The Claude Code credentials file has no claudeAiOauth section',
      {retryable: false},
    );
  }

  const oauth = payload.claudeAiOauth;
  const accessToken = stringValue(oauth.accessToken);
  if (!accessToken) {
    throw new ProviderRuntimeError(
      'invalid-response',
      'The Claude Code credentials file has no access token',
      {retryable: false},
    );
  }

  return {
    accessToken,
    refreshToken: stringValue(oauth.refreshToken),
    scopes: Array.isArray(oauth.scopes)
      ? oauth.scopes.filter(scope => typeof scope === 'string')
      : [],
    expiresAt: epochMs(oauth.expiresAt),
    subscriptionType: nullableString(oauth.subscriptionType),
    rateLimitTier: nullableString(oauth.rateLimitTier),
  };
}

/**
 * Reads the credential on every call, so a token the Claude CLI rotated in
 * the meantime is picked up without reloading the extension.
 */
export async function readClaudeCredential(): Promise<ClaudeCredential> {
  const path = claudeCredentialPath();
  const file = Gio.File.new_for_path(path);

  let contents: Uint8Array;
  try {
    contents = await loadContents(file);
  } catch (caught) {
    throw new ProviderRuntimeError(
      'missing-config',
      `Could not read ${path}`,
      {cause: caught, retryable: false},
    );
  }

  return parseClaudeCredential(new TextDecoder().decode(contents));
}

function loadContents(file: Gio.File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    file.load_contents_async(null, (source, result) => {
      try {
        const [, contents] = source!.load_contents_finish(result);
        resolve(contents);
      } catch (caught) {
        reject(caught);
      }
    });
  });
}

function epochMs(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return null;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text.length > 0 ? text : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

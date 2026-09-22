import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {ClaudeCredential} from './claude-credentials.js';
import type {RuntimeEnvironment} from './environment-parser.js';
import {ProviderRuntimeError} from './errors.js';

/** A renewal that has not finished by then is treated as failed. */
const RENEW_TIMEOUT_SECONDS = 45;

/**
 * Scopes used only when the credential file does not declare its own: Claude
 * Code rejects a refresh token whose scopes are not restated.
 */
const FALLBACK_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

/**
 * Variables the CLI needs to reach Anthropic. GNOME Shell itself is started
 * without a proxy, so the proxy settings of the runtime environment have to be
 * passed on explicitly (the same reason command-runner passes them on).
 */
const CHILD_ENVIRONMENT_KEYS = [
  'PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

/**
 * Asks the Claude Code CLI to exchange its refresh token for a fresh access
 * token, using the CLI's non-interactive login environment. The refresh token
 * travels through the child environment, never through argv, and is not kept
 * afterwards; the CLI writes the new credential file for us.
 */
export class ClaudeAuth {
  readonly #environment: RuntimeEnvironment;
  #renewal: Promise<boolean> | null = null;

  constructor(environment: RuntimeEnvironment) {
    this.#environment = environment;
  }

  renew(credential: ClaudeCredential): Promise<boolean> {
    if (!credential.refreshToken)
      return Promise.resolve(false);

    if (!GLib.find_program_in_path('claude')) {
      throw new ProviderRuntimeError(
        'executable-not-found',
        'The Claude CLI (claude) was not found in PATH',
        {retryable: false},
      );
    }

    this.#renewal ??= this.#spawnRenewal(credential).finally(() => {
      this.#renewal = null;
    });
    return this.#renewal;
  }

  dispose(): void {
    this.#renewal = null;
  }

  async #spawnRenewal(credential: ClaudeCredential): Promise<boolean> {
    const scopes = credential.scopes.length > 0
      ? credential.scopes
      : FALLBACK_SCOPES;

    let process: Gio.Subprocess;
    try {
      const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_SILENCE |
          Gio.SubprocessFlags.STDERR_SILENCE,
      });
      // Never block on a prompt inherited from GNOME Shell.
      launcher.set_stdin_file_path('/dev/null');
      for (const key of CHILD_ENVIRONMENT_KEYS) {
        const value = this.#environment[key];
        if (value !== undefined && value.length > 0)
          launcher.setenv(key, value, true);
      }
      launcher.setenv(
        'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
        credential.refreshToken,
        true,
      );
      launcher.setenv('CLAUDE_CODE_OAUTH_SCOPES', scopes.join(' '), true);
      process = launcher.spawnv(['claude', 'auth', 'login', '--claudeai']);
    } catch {
      return false;
    }

    const timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      RENEW_TIMEOUT_SECONDS,
      () => {
        process.force_exit();
        return GLib.SOURCE_REMOVE;
      },
    );

    try {
      return await waitCheck(process);
    } finally {
      if (GLib.MainContext.default().find_source_by_id(timeoutId))
        GLib.source_remove(timeoutId);
    }
  }
}

function waitCheck(process: Gio.Subprocess): Promise<boolean> {
  return new Promise(resolve => {
    process.wait_check_async(null, (source, result) => {
      try {
        // Throws on a non-zero exit, which the CLI uses for a failed renewal.
        resolve(source!.wait_check_finish(result));
      } catch {
        resolve(false);
      }
    });
  });
}

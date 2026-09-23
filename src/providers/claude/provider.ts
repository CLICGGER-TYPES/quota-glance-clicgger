import type Gio from 'gi://Gio';

import {
  effectiveData,
  isStale,
  type UsageProvider,
} from '../../core/provider.js';
import type {
  MetricViewModel,
  PanelItem,
  ProviderState,
  ProviderViewModel,
} from '../../core/types.js';
import {ClaudeAuth} from '../../runtime/claude-auth.js';
import {
  readClaudeCredential,
  type ClaudeCredential,
} from '../../runtime/claude-credentials.js';
import {ProviderRuntimeError} from '../../runtime/errors.js';
import type {Translator} from '../../shared/i18n/index.js';
import type {HttpProviderDependencies} from '../http-dependencies.js';
import {
  parseClaudeUsageResponse,
  selectWindow,
  type ClaudeData,
  type ClaudeLimitWindow,
} from './parser.js';

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Undocumented OAuth beta flag that the Claude Code usage screen uses. The
 * endpoint itself is not part of Anthropic's public API, so a server side
 * change can break live data.
 */
const OAUTH_BETA = 'oauth-2025-04-20';

/** Used when a 429 does not say how long to wait. */
const RATE_LIMIT_FALLBACK_SECONDS = 900;

export class ClaudeProvider implements UsageProvider<ClaudeData> {
  readonly id = 'claude';
  readonly name = 'Claude';
  readonly order = 15;
  readonly enabledByDefault = false;
  readonly #dependencies: HttpProviderDependencies;
  readonly #translator: Translator;
  readonly #auth: ClaudeAuth;
  /** The usage endpoint rate limits for minutes at a time; wait it out. */
  #rateLimitedUntil = 0;

  constructor(
    dependencies: HttpProviderDependencies,
    translator: Translator,
  ) {
    this.#dependencies = dependencies;
    this.#translator = translator;
    this.#auth = new ClaudeAuth(dependencies.environment);
  }

  async collect(cancellable: Gio.Cancellable): Promise<ClaudeData> {
    this.#throwIfRateLimited();
    const credential = await this.#readCredential();
    try {
      return await this.#requestUsage(credential, cancellable);
    } catch (caught) {
      // An expired access token is normal: Claude Code renews it on demand,
      // so ask the CLI to do the same once before reporting a failure.
      if (!isAuthenticationFailure(caught))
        throw this.#describeHttpFailure(caught);

      const renewed = await this.#renew(credential, caught);
      if (!renewed) {
        throw new ProviderRuntimeError(
          'not-authenticated',
          this.#translator.t('error.claude.signIn'),
          {cause: caught, localized: true, retryable: false},
        );
      }
    }

    try {
      return await this.#requestUsage(
        await this.#readCredential(),
        cancellable,
      );
    } catch (caught) {
      throw this.#describeHttpFailure(caught);
    }
  }

  getPanelItems(state: ProviderState<ClaudeData>): PanelItem[] {
    const data = effectiveData(state);
    // One number only, like Codex: the weekly window is the one worth
    // planning around, the session window is short lived. Both stay visible
    // in the popup menu.
    const window = data
      ? selectWindow(data, 'weekly') ?? data.limits[0] ?? null
      : null;
    return [{
      text: window ? `${Math.round(window.remainingPercent)}%` : '--',
      priority: 25,
    }];
  }

  getPopupViewModel(state: ProviderState<ClaudeData>): ProviderViewModel {
    const data = effectiveData(state);
    return {
      title: this.#translator.t('provider.claude.title'),
      badge: data?.planLabel ?? undefined,
      metrics: data ? createMetrics(data, this.#translator) : [],
      details: [],
      footer: isStale(state)
        ? this.#translator.t('provider.common.showingLastData')
        : undefined,
      phase: state.phase,
      stale: isStale(state),
      error: state.error ?? undefined,
    };
  }

  dispose(): void {
    this.#auth.dispose();
  }

  async #readCredential(): Promise<ClaudeCredential> {
    try {
      return await readClaudeCredential();
    } catch (caught) {
      if (!(caught instanceof ProviderRuntimeError))
        throw caught;

      throw new ProviderRuntimeError(
        caught.code === 'missing-config' ? 'missing-config' : 'invalid-response',
        this.#translator.t('error.claude.missingCredentials'),
        {cause: caught, localized: true, retryable: false},
      );
    }
  }

  async #requestUsage(
    credential: ClaudeCredential,
    cancellable: Gio.Cancellable,
  ): Promise<ClaudeData> {
    const payload = await this.#dependencies.http.requestJson<unknown>({
      method: 'GET',
      url: ENDPOINT,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': 'Quota-Glance/0.1',
      },
    }, cancellable);

    return parseClaudeUsageResponse(payload, {
      subscriptionType: credential.subscriptionType,
      rateLimitTier: credential.rateLimitTier,
    });
  }

  /**
   * HTTP status failures get a message that says what actually happened. The
   * generic "network request failed" text is reserved for transport errors.
   */
  #describeHttpFailure(caught: unknown): unknown {
    if (!(caught instanceof ProviderRuntimeError) ||
        caught.httpStatus === undefined) {
      return caught;
    }

    const status = caught.httpStatus;
    if (status === 429) {
      const seconds = caught.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS;
      this.#rateLimitedUntil = Date.now() + seconds * 1000;
      return new ProviderRuntimeError(
        'http',
        this.#translator.t('error.claude.rateLimited', {
          minutes: Math.max(1, Math.ceil(seconds / 60)),
        }),
        {
          cause: caught,
          httpStatus: status,
          localized: true,
          retryAfterSeconds: seconds,
          retryable: false,
        },
      );
    }

    if (status >= 500) {
      return new ProviderRuntimeError(
        'http',
        this.#translator.t('error.claude.serverError', {status}),
        {cause: caught, httpStatus: status, localized: true, retryable: true},
      );
    }

    return new ProviderRuntimeError(
      'http',
      this.#translator.t('error.claude.httpStatus', {status}),
      {cause: caught, httpStatus: status, localized: true, retryable: false},
    );
  }

  /** The endpoint rate limits for minutes at a time: skip it until then. */
  #throwIfRateLimited(): void {
    const remaining = this.#rateLimitedUntil - Date.now();
    if (remaining <= 0)
      return;

    throw new ProviderRuntimeError(
      'http',
      this.#translator.t('error.claude.rateLimited', {
        minutes: Math.max(1, Math.ceil(remaining / 60_000)),
      }),
      {httpStatus: 429, localized: true, retryable: false},
    );
  }

  async #renew(
    credential: ClaudeCredential,
    cause: unknown,
  ): Promise<boolean> {
    try {
      return await this.#auth.renew(credential);
    } catch (caught) {
      if (caught instanceof ProviderRuntimeError &&
          caught.code === 'executable-not-found') {
        throw new ProviderRuntimeError(
          'executable-not-found',
          this.#translator.t('error.claude.missingCli'),
          {cause, localized: true, retryable: false},
        );
      }
      throw caught;
    }
  }
}

function createMetrics(
  data: ClaudeData,
  translator: Translator,
): MetricViewModel[] {
  return data.limits.map(window => {
    const resetAt = window.resetsAt === null
      ? null
      : Date.parse(window.resetsAt);
    return {
      id: window.id,
      label: windowLabel(window, translator),
      value: `${window.remainingPercent}%`,
      progress: window.remainingPercent / 100,
      resetAt: resetAt !== null && Number.isFinite(resetAt)
        ? resetAt
        : undefined,
    };
  });
}

function windowLabel(
  window: ClaudeLimitWindow,
  translator: Translator,
): string {
  if (window.kind === 'session')
    return translator.t('provider.claude.window.session');
  if (window.kind === 'weekly')
    return translator.t('provider.claude.window.weekly');
  return translator.t('provider.claude.window.scoped', {
    name: window.modelName ?? window.id,
  });
}

function isAuthenticationFailure(caught: unknown): boolean {
  return caught instanceof ProviderRuntimeError &&
    caught.code === 'not-authenticated';
}

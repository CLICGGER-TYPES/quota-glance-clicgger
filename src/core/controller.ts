import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {UsageProvider} from './provider.js';
import {StateStore} from './state-store.js';
import type {
  ProviderError,
  RefreshResult,
  RefreshSummary,
} from './types.js';
import {normalizeProviderError} from '../runtime/errors.js';

type ControllerListener = () => void;

/**
 * The first refresh after login regularly runs before the network is ready —
 * a proxy that is started by the session (v2rayN, a VPN client) is up a few
 * seconds after GNOME Shell is. Retry network failures a few times with a
 * short delay before leaving it to the periodic refresh.
 */
const DEFAULT_RETRY_DELAYS_SECONDS = [10, 30, 90];

export interface RefreshControllerOptions {
  retryDelaysSeconds?: readonly number[];
}

export class RefreshController {
  readonly #providers: UsageProvider[];
  readonly #store: StateStore;
  readonly #listeners = new Set<ControllerListener>();
  readonly #retryDelays: readonly number[];
  readonly #pendingRetryIds = new Set<string>();
  #cancellable: Gio.Cancellable | null = null;
  #disposed = false;
  #generation = 0;
  #refreshing = false;
  #retryAttempt = 0;
  #retrySourceId = 0;

  constructor(
    providers: UsageProvider[],
    store: StateStore,
    options: RefreshControllerOptions = {},
  ) {
    this.#providers = providers;
    this.#store = store;
    this.#retryDelays = options.retryDelaysSeconds ??
      DEFAULT_RETRY_DELAYS_SECONDS;
  }

  get isRefreshing(): boolean {
    return this.#refreshing;
  }

  subscribe(listener: ControllerListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async refreshAll(): Promise<RefreshSummary> {
    if (this.#disposed || this.#refreshing)
      return {started: false, results: []};

    const providers = this.#providers.filter(provider =>
      this.#store.get(provider.id)?.enabled);
    if (providers.length === 0)
      return {started: false, results: []};

    return this.#refreshProviders(providers);
  }

  async refreshProvider(providerId: string): Promise<RefreshSummary> {
    if (this.#disposed || this.#refreshing)
      return {started: false, results: []};

    const provider = this.#providers.find(candidate =>
      candidate.id === providerId);
    if (!provider || !this.#store.get(providerId)?.enabled)
      return {started: false, results: []};

    return this.#refreshProviders([provider]);
  }

  setProviderEnabled(providerId: string, enabled: boolean): void {
    const state = this.#store.get(providerId);
    if (!state || state.enabled === enabled)
      return;

    this.#store.setEnabled(providerId, enabled);
    if (enabled)
      void this.refreshProvider(providerId);
  }

  cancelCurrentRefresh(): void {
    this.#generation++;
    this.#cancellable?.cancel();
    this.#cancellable = null;
    this.#refreshing = false;
    this.#emit();
  }

  dispose(): void {
    if (this.#disposed)
      return;

    this.#disposed = true;
    this.cancelCurrentRefresh();
    this.#resetRetry();
    this.#listeners.clear();
  }

  async #refreshProviders(
    providers: UsageProvider[],
  ): Promise<RefreshSummary> {
    this.#refreshing = true;
    this.#emit();

    const generation = ++this.#generation;
    const cancellable = new Gio.Cancellable();
    this.#cancellable = cancellable;

    for (const provider of providers)
      this.#store.markLoading(provider.id);

    const results = await Promise.all(
      providers.map(provider =>
        this.#collectProvider(provider, cancellable, generation)),
    );

    if (this.#generation === generation) {
      this.#cancellable = null;
      this.#refreshing = false;
      this.#emit();
    }

    this.#handleResults(results);
    return {started: true, results};
  }

  #handleResults(results: readonly RefreshResult[]): void {
    const failed = new Set(results
      .filter(result => !result.ok && isRetryableNetworkError(result.error))
      .map(result => result.providerId));

    if (failed.size === 0) {
      this.#resetRetry();
      return;
    }

    for (const providerId of failed)
      this.#pendingRetryIds.add(providerId);

    if (this.#retryAttempt >= this.#retryDelays.length)
      return;

    const delay = this.#retryDelays[this.#retryAttempt];
    this.#retryAttempt += 1;
    this.#armRetry(delay);
  }

  #armRetry(delaySeconds: number): void {
    if (this.#retrySourceId !== 0)
      return;

    this.#retrySourceId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      delaySeconds,
      () => {
        this.#retrySourceId = 0;
        const providerIds = [...this.#pendingRetryIds];
        this.#pendingRetryIds.clear();

        if (this.#refreshing) {
          // A refresh is already running: try again a bit later.
          for (const providerId of providerIds)
            this.#pendingRetryIds.add(providerId);
          this.#armRetry(delaySeconds);
          return GLib.SOURCE_REMOVE;
        }

        for (const providerId of providerIds)
          void this.refreshProvider(providerId);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  #resetRetry(): void {
    this.#retryAttempt = 0;
    this.#pendingRetryIds.clear();
    if (this.#retrySourceId === 0)
      return;

    if (GLib.MainContext.default().find_source_by_id(this.#retrySourceId))
      GLib.source_remove(this.#retrySourceId);
    this.#retrySourceId = 0;
  }

  async #collectProvider(
    provider: UsageProvider,
    cancellable: Gio.Cancellable,
    generation: number,
  ): Promise<RefreshResult> {
    try {
      const data = await provider.collect(cancellable);
      if (this.#canApply(provider.id, cancellable, generation))
        this.#store.markReady(provider.id, data);
      return {providerId: provider.id, ok: true};
    } catch (caught) {
      const error = normalizeProviderError(caught);
      if (this.#canApply(provider.id, cancellable, generation))
        this.#store.markError(provider.id, error);
      return {providerId: provider.id, ok: false, error};
    }
  }

  #canApply(
    providerId: string,
    cancellable: Gio.Cancellable,
    generation: number,
  ): boolean {
    return !this.#disposed &&
      !cancellable.is_cancelled() &&
      generation === this.#generation &&
      Boolean(this.#store.get(providerId)?.enabled);
  }

  #emit(): void {
    for (const listener of this.#listeners)
      listener();
  }
}

function isRetryableNetworkError(error: ProviderError | undefined): boolean {
  if (!error || !error.retryable)
    return false;

  return error.code === 'http' || error.code === 'timeout';
}

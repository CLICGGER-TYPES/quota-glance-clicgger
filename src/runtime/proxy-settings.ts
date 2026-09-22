import type {RuntimeEnvironment} from './environment-parser.js';

/** Environment variables a proxy can be configured through. */
export const PROXY_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

export interface ProxySettings {
  noProxy: string;
  url: string;
}

interface SettingsLike {
  get_string(key: string): string;
}

export const SETTINGS_PROXY_URL = 'proxy-url';
export const SETTINGS_PROXY_NO_PROXY = 'proxy-no-proxy';

export function proxySettings(settings: SettingsLike): ProxySettings {
  return {
    url: settings.get_string(SETTINGS_PROXY_URL),
    noProxy: settings.get_string(SETTINGS_PROXY_NO_PROXY),
  };
}

/**
 * Overlays the proxy configured in the preferences window on top of the
 * environment loaded from disk, in place — the providers and the command
 * runner keep a reference to this same object, so mutating it is what makes a
 * preference change take effect without reloading the extension.
 *
 * An empty URL means "keep whatever the environment says", so a proxy from
 * `/etc/environment` or `~/.config/quota-glance/env` still works; the base
 * environment is restored first, which makes clearing the field in the
 * preferences window work too.
 */
export function applyProxySettings(
  environment: RuntimeEnvironment,
  base: RuntimeEnvironment,
  settings: ProxySettings,
): void {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    delete environment[key];
    const value = base[key];
    if (value !== undefined)
      environment[key] = value;
  }

  const url = settings.url.trim();
  if (url.length > 0) {
    environment.HTTP_PROXY = url;
    environment.HTTPS_PROXY = url;
    environment.http_proxy = url;
    environment.https_proxy = url;
  }

  const noProxy = settings.noProxy.trim();
  if (noProxy.length > 0) {
    environment.NO_PROXY = noProxy;
    environment.no_proxy = noProxy;
  }
}

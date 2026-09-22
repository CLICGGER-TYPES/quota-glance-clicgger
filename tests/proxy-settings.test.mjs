import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProxySettings,
  PROXY_ENVIRONMENT_KEYS,
  proxySettings,
} from '../.build-js/runtime/proxy-settings.js';

test('the proxy preference overrides the environment proxy', () => {
  const base = {HTTPS_PROXY: 'http://env:3128', PATH: '/usr/bin'};
  const environment = {...base};

  applyProxySettings(environment, base, {
    url: 'http://127.0.0.1:2080',
    noProxy: 'localhost,127.0.0.1',
  });

  assert.equal(environment.HTTP_PROXY, 'http://127.0.0.1:2080');
  assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:2080');
  assert.equal(environment.http_proxy, 'http://127.0.0.1:2080');
  assert.equal(environment.https_proxy, 'http://127.0.0.1:2080');
  assert.equal(environment.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(environment.no_proxy, 'localhost,127.0.0.1');
  // Unrelated variables are left alone.
  assert.equal(environment.PATH, '/usr/bin');
});

test('an empty proxy preference keeps the environment proxy', () => {
  const base = {HTTPS_PROXY: 'http://env:3128', PATH: '/usr/bin'};
  const environment = {...base};

  applyProxySettings(environment, base, {url: '   ', noProxy: ''});

  assert.equal(environment.HTTPS_PROXY, 'http://env:3128');
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.NO_PROXY, undefined);
});

test('clearing the preference removes a previous override', () => {
  const base = {HTTPS_PROXY: 'http://env:3128'};
  const environment = {...base};

  applyProxySettings(environment, base, {
    url: 'http://127.0.0.1:2080',
    noProxy: 'localhost',
  });
  applyProxySettings(environment, base, {url: '', noProxy: ''});

  assert.equal(environment.HTTPS_PROXY, 'http://env:3128');
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.deepEqual(
    Object.keys(environment)
      .filter(key => PROXY_ENVIRONMENT_KEYS.includes(key)),
    ['HTTPS_PROXY'],
  );
});

test('proxy settings are read through the schema keys', () => {
  const values = new Map([
    ['proxy-url', 'http://127.0.0.1:2080'],
    ['proxy-no-proxy', 'localhost'],
  ]);
  const settings = {get_string: key => values.get(key) ?? ''};

  assert.deepEqual(
    proxySettings(settings),
    {url: 'http://127.0.0.1:2080', noProxy: 'localhost'},
  );
});

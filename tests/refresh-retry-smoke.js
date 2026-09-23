import GLib from 'gi://GLib';

import {RefreshController} from '../.build-js/core/controller.js';
import {StateStore} from '../.build-js/core/state-store.js';
import {ProviderRuntimeError} from '../.build-js/runtime/errors.js';

const RETRY_DELAY_SECONDS = 1;

function createFlakyProvider(id, failures) {
    let attempts = 0;
    return {
        id,
        name: id,
        order: 1,
        enabledByDefault: true,
        get attempts() {
            return attempts;
        },
        collect() {
            attempts += 1;
            if (attempts <= failures) {
                return Promise.reject(new ProviderRuntimeError(
                    'http', 'Network request failed'));
            }
            return Promise.resolve({attempts});
        },
        getPanelItems() {
            return [];
        },
        getPopupViewModel() {
            return {
                title: id, metrics: [], details: [], phase: 'ready', stale: false,
            };
        },
        dispose() {},
    };
}

function delay(seconds) {
    return new Promise(resolve => {
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const store = new StateStore();
const provider = createFlakyProvider('flaky', 1);
store.initializeProvider('flaky', true);
const controller = new RefreshController([provider], store, {
    retryDelaysSeconds: [RETRY_DELAY_SECONDS],
});

const first = await controller.refreshAll();
if (first.results[0]?.ok)
    throw new Error('The first attempt was expected to fail');
if (store.get('flaky').phase !== 'error')
    throw new Error(`Expected the error phase, got ${store.get('flaky').phase}`);

await delay(RETRY_DELAY_SECONDS + 2);

if (store.get('flaky').phase !== 'ready') {
    throw new Error(
        `The retry was expected to succeed, got ${store.get('flaky').phase}`);
}

// A successful refresh must stop the retry ladder.
await delay(RETRY_DELAY_SECONDS + 2);
if (provider.attempts !== 2) {
    throw new Error(
        `Expected exactly 2 attempts, got ${provider.attempts}`);
}

// A provider that keeps failing must not be retried forever.
const hopeless = createFlakyProvider('hopeless', 100);
store.initializeProvider('hopeless', true);
const hopelessController = new RefreshController([hopeless], store, {
    retryDelaysSeconds: [1, 1],
});
await hopelessController.refreshAll();
await delay(6);
if (hopeless.attempts !== 3) {
    throw new Error(
        `Expected 3 attempts from the two-step ladder, got ${hopeless.attempts}`);
}
hopelessController.dispose();
controller.dispose();

print('refresh retry smoke test passed');

// A server that asked us to wait (429 + retry-after) must not be retried in a
// hurry: the periodic refresh owns it instead.
function createRateLimitedProvider(id) {
    let attempts = 0;
    return {
        id,
        name: id,
        order: 1,
        enabledByDefault: true,
        get attempts() {
            return attempts;
        },
        collect() {
            attempts += 1;
            return Promise.reject(new ProviderRuntimeError(
                'http', 'HTTP 429', {
                    httpStatus: 429,
                    retryAfterSeconds: 3600,
                    retryable: false,
                }));
        },
        getPanelItems() {
            return [];
        },
        getPopupViewModel() {
            return {
                title: id, metrics: [], details: [], phase: 'error', stale: false,
            };
        },
        dispose() {},
    };
}

const limited = createRateLimitedProvider('limited');
store.initializeProvider('limited', true);
const limitedController = new RefreshController([limited], store, {
    retryDelaysSeconds: [1, 1],
});
await limitedController.refreshAll();
await delay(4);
if (limited.attempts !== 1) {
    throw new Error(
        `A rate limited provider must not be fast-retried, got ${limited.attempts}`);
}
limitedController.dispose();


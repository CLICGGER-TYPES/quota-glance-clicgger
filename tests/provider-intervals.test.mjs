import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectiveIntervalMinutes,
  normalizeIntervals,
  providerMinimumMinutes,
  withProviderInterval,
} from '../.build-js/runtime/provider-intervals.js';

test('a missing or zero entry means "no extra throttle"', () => {
  assert.equal(providerMinimumMinutes({}, 'claude'), 0);
  assert.equal(providerMinimumMinutes({claude: 30}, 'codex'), 0);
  assert.equal(effectiveIntervalMinutes({}, 'claude', 5), 5);
  assert.equal(effectiveIntervalMinutes({claude: 30}, 'claude', 5), 30);
  assert.equal(effectiveIntervalMinutes({claude: 30}, 'codex', 5), 5);
});

test('intervals from the settings are sanitized', () => {
  assert.deepEqual(normalizeIntervals({'claude': 30, 'codex': 0, 'zai': -5}), {
    claude: 30,
  });
  assert.deepEqual(normalizeIntervals({'deepseek': 12.7}), {deepseek: 12});
  assert.deepEqual(normalizeIntervals({'claude': 99999}), {claude: 1440});
  assert.deepEqual(normalizeIntervals(null), {});
  assert.deepEqual(normalizeIntervals('nonsense'), {});
});

test('writing an interval keeps the other providers untouched', () => {
  const start = {claude: 30, deepseek: 60};
  assert.deepEqual(withProviderInterval(start, 'codex', 15), {
    claude: 30, deepseek: 60, codex: 15,
  });
  // 0 removes the override
  assert.deepEqual(withProviderInterval(start, 'deepseek', 0), {claude: 30});
  // the input map is not mutated
  assert.deepEqual(start, {claude: 30, deepseek: 60});
});

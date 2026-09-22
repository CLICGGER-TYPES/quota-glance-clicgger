import assert from 'node:assert/strict';
import test from 'node:test';

import {
  panelBoxPosition,
  resolvePanel,
  resolvePanelBox,
} from '../.build-js/host/panel-target.js';

test('panel target selects the primary Dash to Panel panel', () => {
  const mainPanel = {name: 'gnome-main'};
  const secondaryPanel = {name: 'secondary-dtp'};
  const primaryPanel = {name: 'primary-dtp'};
  const primaryEntry = {
    panel: primaryPanel,
    isPrimary: true,
    geom: {position: 3},
  };

  const resolved = resolvePanel(
    mainPanel,
    {
      panels: [
        {panel: secondaryPanel, isPrimary: false},
        primaryEntry,
      ],
    },
    'dash-to-panel',
  );

  assert.equal(resolved.entry, primaryEntry);
  assert.equal(resolved.panel, primaryPanel);
  assert.equal(resolved.target, 'dash-to-panel');
});

test('panel target falls back when Dash to Panel is unavailable', () => {
  const mainPanel = {name: 'gnome-main'};
  const resolved = resolvePanel(mainPanel, undefined, 'dash-to-panel');

  assert.equal(resolved.panel, mainPanel);
  assert.equal(resolved.target, 'main');
});

test('panel target selects only a panel at the required position', () => {
  const mainPanel = {name: 'gnome-main'};
  const topPanel = {name: 'top-dtp'};
  const bottomPanel = {name: 'bottom-dtp'};
  const resolved = resolvePanel(
    mainPanel,
    {
      panels: [
        {
          panel: topPanel,
          isPrimary: true,
          geom: {position: 0},
        },
        {
          panel: bottomPanel,
          isPrimary: false,
          geom: {position: 1},
        },
      ],
    },
    'dash-to-panel',
    1,
  );

  assert.equal(resolved.panel, bottomPanel);
  assert.equal(resolved.target, 'dash-to-panel');
});

test('panel target falls back when no panel matches the required position', () => {
  const mainPanel = {name: 'gnome-main'};
  const resolved = resolvePanel(
    mainPanel,
    {
      panels: [{
        panel: {name: 'top-dtp'},
        isPrimary: true,
        geom: {position: 0},
      }],
    },
    'dash-to-panel',
    1,
  );

  assert.equal(resolved.panel, mainPanel);
  assert.equal(resolved.target, 'main');
});

test('main panel target ignores Dash to Panel', () => {
  const mainPanel = {name: 'gnome-main'};
  const dashPanel = {name: 'primary-dtp'};
  const resolved = resolvePanel(
    mainPanel,
    {panels: [{panel: dashPanel, isPrimary: true}]},
    'main',
  );

  assert.equal(resolved.panel, mainPanel);
  assert.equal(resolved.target, 'main');
});

test('panel box defaults to the left of the GNOME main panel', () => {
  assert.equal(resolvePanelBox('main', undefined), 'left');
  assert.equal(resolvePanelBox('main', 'left'), 'left');
  assert.equal(resolvePanelBox('main', 'center'), 'center');
  assert.equal(resolvePanelBox('main', 'right'), 'right');
  assert.equal(resolvePanelBox('main', 'nonsense'), 'left');
  // A Dash to Panel bar only has a taskbar area.
  assert.equal(resolvePanelBox('dash-to-panel', 'left'), 'center');
});

test('left box position appends after the session mode items', () => {
  assert.equal(panelBoxPosition('left', 1, false), 1);
  assert.equal(panelBoxPosition('left', 1, true), 2);
  assert.equal(panelBoxPosition('left', 0, false), 0);
  assert.equal(panelBoxPosition('center', 1, true), 0);
  assert.equal(panelBoxPosition('right', 2, true), 0);
});

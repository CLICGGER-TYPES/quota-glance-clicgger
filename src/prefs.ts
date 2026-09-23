import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
  ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROVIDER_CATALOG} from './shared/provider-catalog.js';
import {
  SETTINGS_PROXY_NO_PROXY,
  SETTINGS_PROXY_URL,
} from './runtime/proxy-settings.js';
import {
  effectiveIntervalMinutes,
  normalizeIntervals,
  SETTINGS_PROVIDER_INTERVAL,
  withProviderInterval,
} from './runtime/provider-intervals.js';
import {
  createTranslator,
  type Translator,
} from './shared/i18n/index.js';

const SETTINGS_ENABLED_PROVIDERS = 'enabled-providers';
const SETTINGS_DASH_TO_PANEL_AVAILABLE = 'dash-to-panel-available';
const SETTINGS_PANEL_TARGET = 'panel-target';
const SETTINGS_PANEL_POSITION = 'panel-position';
const SETTINGS_REFRESH_INTERVAL = 'refresh-interval-minutes';

export default class QuotaGlancePreferences extends ExtensionPreferences {
  override async fillPreferencesWindow(
    window: Adw.PreferencesWindow,
  ): Promise<void> {
    const settings = this.getSettings();
    const translator = createTranslator();
    const page = new Adw.PreferencesPage({
      title: translator.t('app.name'),
      iconName: 'view-dashboard-symbolic',
    });

    page.add(this.#createProviderGroup(settings, translator));
    page.add(this.#createPanelGroup(settings, translator));
    page.add(this.#createProxyGroup(settings, translator));
    page.add(this.#createRefreshGroup(settings, translator));
    window.add(page);
  }

  /** Proxy for provider requests and for the CLI providers we spawn. An empty
   *  URL keeps whatever the environment provides. */
  #createProxyGroup(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: translator.t('prefs.proxy.title'),
      description: translator.t('prefs.proxy.description'),
    });
    group.add(this.#createEntryRow(
      settings,
      SETTINGS_PROXY_URL,
      translator.t('prefs.proxy.url.title'),
    ));
    group.add(this.#createEntryRow(
      settings,
      SETTINGS_PROXY_NO_PROXY,
      translator.t('prefs.proxy.noProxy.title'),
    ));
    return group;
  }

  /** Committed on Enter / the apply button, so typing does not trigger a
   *  refresh per keystroke. */
  #createEntryRow(
    settings: Gio.Settings,
    key: string,
    title: string,
  ): Adw.EntryRow {
    const row = new Adw.EntryRow({
      title,
      showApplyButton: true,
      text: settings.get_string(key),
    });
    row.connect('apply', () => {
      settings.set_string(key, row.text);
      row.set_show_apply_button(false);
    });
    settings.connect(`changed::${key}`, () => {
      const value = settings.get_string(key);
      if (row.text !== value)
        row.text = value;
    });
    return row;
  }

  #createProviderGroup(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: translator.t('prefs.providers.title'),
      description: translator.t('prefs.providers.description'),
    });
    const rows = new Map<string, Adw.SwitchRow>();
    let syncing = false;

    const syncRows = () => {
      syncing = true;
      const enabledProviderIds = new Set(
        settings.get_strv(SETTINGS_ENABLED_PROVIDERS),
      );
      for (const [providerId, row] of rows)
        row.active = enabledProviderIds.has(providerId);
      syncing = false;
    };

    for (const provider of PROVIDER_CATALOG) {
      const row = new Adw.SwitchRow({
        title: provider.name,
        subtitle: translator.t(provider.descriptionKey),
      });
      row.add_prefix(new Gtk.Image({
        gicon: new Gio.FileIcon({
          file: Gio.File.new_for_path(
            `${this.path}/icons/${provider.id}-symbolic.svg`,
          ),
        }),
        pixelSize: 20,
      }));
      rows.set(provider.id, row);
      row.connect('notify::active', () => {
        if (syncing)
          return;

        const enabledProviderIds = new Set(
          settings.get_strv(SETTINGS_ENABLED_PROVIDERS),
        );
        if (row.active)
          enabledProviderIds.add(provider.id);
        else
          enabledProviderIds.delete(provider.id);
        settings.set_strv(
          SETTINGS_ENABLED_PROVIDERS,
          [...enabledProviderIds],
        );
      });
      group.add(row);
    }

    syncRows();
    settings.connect(
      `changed::${SETTINGS_ENABLED_PROVIDERS}`,
      syncRows,
    );
    return group;
  }

  #createPanelGroup(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup();

    group.add(this.#createPanelPositionRow(settings, translator));
    group.add(this.#createPanelTargetRow(settings, translator));
    return group;
  }

  /** Where in the top bar the indicator lives. Always visible, and changing
   *  it remounts the indicator right away — no sign-out needed. */
  #createPanelPositionRow(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.ComboRow {
    const positions: {label: string; value: string}[] = [
      {label: translator.t('prefs.panel.side.left'), value: 'left'},
      {label: translator.t('prefs.panel.side.center'), value: 'center'},
      {label: translator.t('prefs.panel.side.right'), value: 'right'},
    ];
    const choices = new Gtk.StringList();
    for (const position of positions)
      choices.append(position.label);

    const row = new Adw.ComboRow({
      title: translator.t('prefs.panel.side.title'),
      subtitle: translator.t('prefs.panel.side.subtitle'),
      model: choices,
      selected: selectedPositionIndex(positions, settings),
    });
    let syncing = false;

    row.connect('notify::selected', () => {
      if (syncing)
        return;

      const position = positions[row.selected];
      if (position)
        settings.set_string(SETTINGS_PANEL_POSITION, position.value);
    });
    settings.connect(`changed::${SETTINGS_PANEL_POSITION}`, () => {
      syncing = true;
      row.selected = selectedPositionIndex(positions, settings);
      syncing = false;
    });
    return row;
  }

  #createPanelTargetRow(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.ComboRow {
    const choices = new Gtk.StringList();
    choices.append(translator.t('prefs.panel.top'));
    choices.append(translator.t('prefs.panel.bottom'));
    const row = new Adw.ComboRow({
      title: translator.t('prefs.panel.title'),
      subtitle: translator.t('prefs.panel.subtitle'),
      model: choices,
      selected: settings.get_string(SETTINGS_PANEL_TARGET) === 'dash-to-panel'
        ? 1
        : 0,
    });
    let syncing = false;

    row.connect('notify::selected', () => {
      if (!syncing) {
        settings.set_string(
          SETTINGS_PANEL_TARGET,
          row.selected === 1 ? 'dash-to-panel' : 'main',
        );
      }
    });
    settings.connect(`changed::${SETTINGS_PANEL_TARGET}`, () => {
      syncing = true;
      row.selected =
        settings.get_string(SETTINGS_PANEL_TARGET) === 'dash-to-panel' ? 1 : 0;
      syncing = false;
    });
    settings.bind(
      SETTINGS_DASH_TO_PANEL_AVAILABLE,
      row,
      'visible',
      Gio.SettingsBindFlags.GET,
    );
    return row;
  }

  #createRefreshGroup(
    settings: Gio.Settings,
    translator: Translator,
  ): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
      title: translator.t('prefs.refresh.title'),
    });
    const row = new Adw.SpinRow({
      title: translator.t('prefs.refresh.interval.title'),
      subtitle: translator.t('prefs.refresh.interval.subtitle'),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 240,
        stepIncrement: 1,
        pageIncrement: 5,
        value: settings.get_int(SETTINGS_REFRESH_INTERVAL),
      }),
      digits: 0,
      numeric: true,
      snapToTicks: true,
    });
    let syncing = false;

    row.connect('notify::value', () => {
      if (!syncing) {
        settings.set_int(
          SETTINGS_REFRESH_INTERVAL,
          Math.round(row.value),
        );
      }
    });
    settings.connect(`changed::${SETTINGS_REFRESH_INTERVAL}`, () => {
      syncing = true;
      row.value = settings.get_int(SETTINGS_REFRESH_INTERVAL);
      syncing = false;
    });
    group.add(row);
    for (const provider of PROVIDER_CATALOG)
      group.add(this.#createProviderIntervalRow(settings, translator, provider));
    return group;
  }

  /** Per-provider throttle: the Claude usage endpoint, for instance, answers
   *  429 when it is polled too often. 0 means "follow the global interval". */
  #createProviderIntervalRow(
    settings: Gio.Settings,
    translator: Translator,
    provider: {id: string; name: string},
  ): Adw.SpinRow {
    const read = () => normalizeIntervals(
      settings.get_value(SETTINGS_PROVIDER_INTERVAL).deepUnpack(),
    );
    const row = new Adw.SpinRow({
      title: translator.t('prefs.refresh.provider.title', {
        name: provider.name,
      }),
      subtitle: translator.t('prefs.refresh.provider.subtitle'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 240,
        stepIncrement: 5,
        pageIncrement: 30,
        value: effectiveIntervalMinutes(
          read(),
          provider.id,
          settings.get_int(SETTINGS_REFRESH_INTERVAL),
        ),
      }),
      digits: 0,
      numeric: true,
      snapToTicks: true,
    });
    let syncing = false;

    row.connect('notify::value', () => {
      if (syncing)
        return;

      const next = withProviderInterval(
        read(),
        provider.id,
        Math.round(row.value),
      );
      settings.set_value(
        SETTINGS_PROVIDER_INTERVAL,
        new GLib.Variant('a{si}', next),
      );
    });
    settings.connect(`changed::${SETTINGS_PROVIDER_INTERVAL}`, () => {
      syncing = true;
      row.value = effectiveIntervalMinutes(
        read(),
        provider.id,
        settings.get_int(SETTINGS_REFRESH_INTERVAL),
      );
      syncing = false;
    });
    return row;
  }
}


function selectedPositionIndex(
  positions: readonly {value: string}[],
  settings: Gio.Settings,
): number {
  const current = settings.get_string(SETTINGS_PANEL_POSITION);
  const index = positions.findIndex(position => position.value === current);
  return index >= 0 ? index : 0;
}

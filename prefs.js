import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TrashDropBridgePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const feedbackGroup = new Adw.PreferencesGroup({
            title: 'Feedback',
            description: 'Choose what happens visually after dropping files on Trash.',
        });
        page.add(feedbackGroup);

        const notificationRow = new Adw.SwitchRow({
            title: 'Show notification',
            subtitle: 'Show “Moved to Trash” after a successful drop.',
        });
        feedbackGroup.add(notificationRow);
        settings.bind(
            'show-notifications',
            notificationRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const snapbackRow = new Adw.SwitchRow({
            title: 'Hide snap-back animation',
            subtitle: 'Hide the misleading rejected-drop animation after a successful Trash drop.',
        });
        feedbackGroup.add(snapbackRow);
        settings.bind(
            'suppress-snapback',
            snapbackRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}

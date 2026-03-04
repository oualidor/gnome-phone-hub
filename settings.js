import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SETTINGS_DIR = GLib.get_user_data_dir() + '/phone-hub';
const SETTINGS_FILE = SETTINGS_DIR + '/settings.json';

export function loadSettings() {
    const file = Gio.File.new_for_path(SETTINGS_FILE);
    if (!file.query_exists(null)) {
        return { phoneIp: null, enableCallNotifications: true, deviceName: 'Paired Phone' };
    }

    try {
        const [success, contents] = file.load_contents(null);
        if (success) {
            const decoder = new TextDecoder('utf-8');
            const data = JSON.parse(decoder.decode(contents));
            if (data.enableCallNotifications === undefined) {
                data.enableCallNotifications = true;
            }
            if (!data.deviceName) {
                data.deviceName = 'Paired Phone';
            }
            return data;
        }
    } catch (e) {
        console.error(`Error loading settings: ${e.message}`);
    }
    return { phoneIp: null, enableCallNotifications: true };
}

export function saveSettings(settings) {
    try {
        const dir = Gio.File.new_for_path(SETTINGS_DIR);
        if (!dir.query_exists(null)) {
            dir.make_directory_with_parents(null);
        }

        const file = Gio.File.new_for_path(SETTINGS_FILE);
        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(settings, null, 2));
        file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        console.error(`Error saving settings: ${e.message}`);
        return false;
    }
}

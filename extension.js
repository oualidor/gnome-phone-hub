import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

const PhoneHubToggle = GObject.registerClass({
    GTypeName: 'PhoneHubToggle',
}, class PhoneHubToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: 'Phone HUB',
            iconName: 'phone-symbolic',
            toggleMode: true,
        });

        this.subtitle = 'Searching...';
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this._scanning = true;
        this._activeProcesses = new Map();
    }

    getBattery(deviceId) {
        try {
            // Using 'dumpsys battery' to get the level
            let [success, stdout] = GLib.spawn_command_line_sync(`/usr/bin/adb -s ${deviceId} shell dumpsys battery`);
            if (success) {
                let output = new TextDecoder().decode(stdout);
                let match = output.match(/level: (\d+)/);
                return match ? `Battery ${match[1]}%` : 'Battery ??%';
            }
        } catch (e) { return 'Error'; }
        return 'N/A';
    }

    refreshDevices() {
        if (!this._scanning) return true; // Keep timer alive but don't rebuild UI

        try {
            let [success, stdout] = GLib.spawn_command_line_sync('/usr/bin/adb devices');
            if (success) {
                let output = new TextDecoder().decode(stdout);
                let lines = output.split('\n');
                let deviceList = lines
                    .filter(line => line && !line.startsWith('List') && line.includes('device'))
                    .map(line => line.split('\t')[0].trim());

                if (deviceList.length > 0) {
                    this._updateMenu(deviceList);
                } else {
                    this.subtitle = 'No devices';
                    this._deviceSection.removeAll();
                }
            }
        } catch (e) { this.subtitle = 'ADB Error'; }
        return true;
    }

    _updateMenu(devices) {
        this._deviceSection.removeAll();
        this.subtitle = `${devices.length} device(s) found`;

        devices.forEach(deviceId => {
            let battery = this.getBattery(deviceId);
            let deviceSubMenu = new PopupMenu.PopupSubMenuMenuItem(`${deviceId} (${battery})`, true);
            deviceSubMenu.iconName = 'phone-symbolic';

            let cameraToggle = new PopupMenu.PopupSwitchMenuItem('Camera (v4l2)', false);

            cameraToggle.connect('toggled', (item, state) => {
                if (state) {
                    this._startCamera(deviceId);
                    this._scanning = false; // Pause scanning while camera is active
                } else {
                    this._stopCamera(deviceId);
                    this._scanning = true;
                }
            });


            let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror', false);

            mirrorToggle.connect('toggled', (item, state) => {
                if (state) {
                    this._startMirroring(deviceId);
                    this._scanning = false; // Pause scanning while camera is active
                } else {
                    this._stopCamera(deviceId);
                    this._scanning = true;
                }
            });

            deviceSubMenu.menu.addMenuItem(cameraToggle);
            deviceSubMenu.menu.addMenuItem(mirrorToggle);
            this._deviceSection.addMenuItem(deviceSubMenu);
        });
    }

    _startCamera(deviceId) {
        try {
            const SCRCPY_PATH = '/opt/scrcpy/scrcpy';
            let proc = Gio.Subprocess.new(
                [
                    SCRCPY_PATH, '-s', deviceId,
                    '--video-source=camera', '--camera-facing=back',
                    '--camera-size=1920x1080', '--max-fps=60',
                    '--v4l2-sink=/dev/video42', '--no-audio', '--no-playback'
                ],
                Gio.SubprocessFlags.NONE
            );
            this._activeProcesses.set(deviceId, proc);

            proc.wait_async(null, (p, res) => {
                this._activeProcesses.delete(deviceId);
                this._scanning = true;
            });
        } catch (e) { console.error(`Scrcpy Error: ${e.message}`); }
    }
    _startMirroring(deviceId) {
        try {
            const SCRCPY_PATH = '/opt/scrcpy/scrcpy';
            let proc = Gio.Subprocess.new(
                [
                    SCRCPY_PATH,
                ],
                Gio.SubprocessFlags.NONE
            );
            this._activeProcesses.set(deviceId, proc);

            proc.wait_async(null, (p, res) => {
                this._activeProcesses.delete(deviceId);
                this._scanning = true;
            });
        } catch (e) { console.error(`Scrcpy Error: ${e.message}`); }
    }

    _stopCamera(deviceId) {
        let proc = this._activeProcesses.get(deviceId);
        if (proc) {
            proc.force_exit();
            this._activeProcesses.delete(deviceId);
        }
    }
});

const PhoneHubIndicator = GObject.registerClass({
    GTypeName: 'PhoneHubIndicator',
}, class PhoneHubIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();
        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'phone-symbolic';
        this._indicator.visible = false;

        this._toggle = new PhoneHubToggle();
        this.quickSettingsItems.push(this._toggle);
        QuickSettingsMenu.addExternalIndicator(this);

        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            return this._toggle.refreshDevices();
        });
    }

    destroy() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        super.destroy();
    }
});

export default class PhoneHubExtension extends Extension {
    enable() { this._indicator = new PhoneHubIndicator(); }
    disable() { this._indicator?.destroy(); this._indicator = null; }
}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

/* ===============================
   PhoneHub Toggle
=================================*/

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
        // Map<deviceId, {camera: Gio.Subprocess|null, mirror: Gio.Subprocess|null}>
        this._activeProcesses = new Map();
    }

    /* ===============================
       Async helper to run commands
    =================================*/

    async _runCommand(argv) {
        return new Promise((resolve) => {
            try {
                let proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        let [, stdout] = p.communicate_utf8_finish(res);
                        resolve(stdout ?? '');
                    } catch {
                        resolve('');
                    }
                });
            } catch {
                resolve('');
            }
        });
    }

    /* ===============================
       Get battery (non-blocking)
    =================================*/

    async getBattery(deviceId) {
        let output = await this._runCommand([
            '/usr/bin/adb',
            '-s', deviceId,
            'shell',
            'dumpsys',
            'battery'
        ]);

        let match = output.match(/level: (\d+)/);
        return match ? `Battery ${match[1]}%` : 'Battery ??%';
    }

    /* ===============================
       Refresh devices (non-blocking)
    =================================*/

    async refreshDevices() {
        if (!this._scanning)
            return true;

        let output = await this._runCommand(['/usr/bin/adb', 'devices']);

        let lines = output.split('\n');
        let deviceList = lines
            .filter(line =>
                line &&
                !line.startsWith('List') &&
                line.includes('\tdevice')
            )
            .map(line => line.split('\t')[0].trim());

        if (deviceList.length === 0) {
            this.subtitle = 'No devices';
            this._deviceSection.removeAll();
            return true;
        }

        // Fetch battery in parallel
        let batteries = await Promise.all(
            deviceList.map(id => this.getBattery(id))
        );

        this._updateMenu(deviceList, batteries);
        return true;
    }

    /* ===============================
       Build Menu
    =================================*/

    _updateMenu(devices, batteries) {
        this._deviceSection.removeAll();
        this.subtitle = `${devices.length} device(s) found`;

        devices.forEach((deviceId, index) => {

            let battery = batteries[index];

            let deviceSubMenu =
                new PopupMenu.PopupSubMenuMenuItem(
                    `${deviceId} (${battery})`,
                    true
                );

            deviceSubMenu.iconName = 'phone-symbolic';

            /* ---------- Camera ---------- */

            let cameraToggle =
                new PopupMenu.PopupSwitchMenuItem('Camera (v4l2)', false);

            cameraToggle.connect('toggled', (item, state) => {
                if (state) {
                    this._startCamera(deviceId);
                    this._scanning = false;
                } else {
                    this._stopCamera(deviceId);
                    this._scanning = true;
                }
            });

            /* ---------- Mirror ---------- */

            let mirrorToggle =
                new PopupMenu.PopupSwitchMenuItem('Mirror', false);

            mirrorToggle.connect('toggled', (item, state) => {
                if (state) {
                    this._startMirroring(deviceId);
                    this._scanning = false;
                } else {
                    this._stopMirror(deviceId);
                    this._scanning = true;
                }
            });

            deviceSubMenu.menu.addMenuItem(cameraToggle);
            deviceSubMenu.menu.addMenuItem(mirrorToggle);
            this._deviceSection.addMenuItem(deviceSubMenu);
        });
    }

    /* ===============================
       Process helpers
    =================================*/

    _getDeviceProcesses(deviceId) {
        if (!this._activeProcesses.has(deviceId)) {
            this._activeProcesses.set(deviceId, { camera: null, mirror: null });
        }
        return this._activeProcesses.get(deviceId);
    }

    _stopCamera(deviceId) {
        let procs = this._activeProcesses.get(deviceId);
        if (procs?.camera) {
            procs.camera.force_exit();
            procs.camera = null;
        }
    }

    _stopMirror(deviceId) {
        let procs = this._activeProcesses.get(deviceId);
        if (procs?.mirror) {
            procs.mirror.force_exit();
            procs.mirror = null;
        }
    }

    _stopAllProcesses() {
        for (let [, procs] of this._activeProcesses) {
            if (procs.camera)
                procs.camera.force_exit();
            if (procs.mirror)
                procs.mirror.force_exit();
        }
        this._activeProcesses.clear();
        this._scanning = true;
    }

    /* ===============================
       Start Camera
    =================================*/

    _startCamera(deviceId) {
        try {
            const SCRCPY_PATH = '/opt/scrcpy/scrcpy';

            let proc = Gio.Subprocess.new(
                [
                    SCRCPY_PATH,
                    '-s', deviceId,
                    '--video-source=camera',
                    '--camera-facing=back',
                    '--camera-size=1920x1080',
                    '--max-fps=60',
                    '--v4l2-sink=/dev/video42',
                    '--no-audio',
                    '--no-playback'
                ],
                Gio.SubprocessFlags.NONE
            );

            let procs = this._getDeviceProcesses(deviceId);
            procs.camera = proc;

            proc.wait_async(null, () => {
                procs.camera = null;
                this._scanning = true;
            });

        } catch (e) {
            console.error(`Camera Error: ${e.message}`);
        }
    }

    /* ===============================
       Start Mirroring
    =================================*/

    _startMirroring(deviceId) {
        try {
            const SCRCPY_PATH = '/opt/scrcpy/scrcpy';

            let proc = Gio.Subprocess.new(
                [
                    SCRCPY_PATH,
                    '-s', deviceId
                ],
                Gio.SubprocessFlags.NONE
            );

            let procs = this._getDeviceProcesses(deviceId);
            procs.mirror = proc;

            proc.wait_async(null, () => {
                procs.mirror = null;
                this._scanning = true;
            });

        } catch (e) {
            console.error(`Mirror Error: ${e.message}`);
        }
    }
});


/* ===============================
   Indicator
=================================*/

const PhoneHubIndicator = GObject.registerClass({
    GTypeName: 'PhoneHubIndicator',
}, class PhoneHubIndicator extends QuickSettings.SystemIndicator {

    _init() {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'phone-symbolic';
        this._indicator.visible = true;

        this._toggle = new PhoneHubToggle();
        this.quickSettingsItems.push(this._toggle);

        QuickSettingsMenu.addExternalIndicator(this);

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            5000,
            () => {
                this._toggle.refreshDevices();
                return true;
            }
        );
    }

    destroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);

        this._toggle._stopAllProcesses();

        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        super.destroy();
    }
});


/* ===============================
   Extension Entry
=================================*/

export default class PhoneHubExtension extends Extension {

    enable() {
        this._indicator = new PhoneHubIndicator();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import St from 'gi://St';
import * as Adb from './adb.js';
import * as Scrcpy from './scrcpy.js';

export const PhoneHubToggle = GObject.registerClass({
    GTypeName: 'PhoneHubToggle',
}, class PhoneHubToggle extends QuickSettings.QuickMenuToggle {

    _init() {
        super._init({
            title: 'Phone HUB',
            iconName: 'phone-symbolic',
            toggleMode: true,
        });

        this.subtitle = 'Disabled';
        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);
        this._scanning = false;

        // Map<deviceId, {camera: Gio.Subprocess|null, mirror: Gio.Subprocess|null, notifications: Gio.Subprocess|null}>
        this._activeProcesses = new Map();

        this.connect('notify::checked', () => {
            if (this.checked) {
                this._scanning = true;
                this.subtitle = 'Searching...';
                this.refreshDevices(true);
            } else {
                this._scanning = false;
                this.stopAllProcesses();
                this._deviceSection.removeAll();
                this.subtitle = 'Disabled';
            }
        });
    }

    /* ===============================
       Refresh devices (non-blocking)
    =================================*/
    async refreshDevices(force = false) {
        if (!this._scanning && !force)
            return true;

        let deviceList = await Adb.getDevices();

        if (deviceList.length === 0) {
            this.subtitle = 'No devices';
            this._deviceSection.removeAll();
            let addDeviceItem = new PopupMenu.PopupMenuItem(`No devices found, refresh to try again`);
            addDeviceItem.connect('activate', () => {
                this._scanning = true;
                this.refreshDevices(true);
            });
            this._deviceSection.addMenuItem(addDeviceItem);
            this._scanning = true;
            return true;
        }

        this._scanning = false;

        let batteries = await Promise.all(
            deviceList.map(id => Adb.getBattery(id))
        );

        this._updateMenu(deviceList, batteries);
        return true;
    }

    /* ===============================
       Build Menu
    =================================*/
    _updateMenu(devices, batteries) {
        this._deviceSection.removeAll();

        let refreshItem = new PopupMenu.PopupMenuItem('Refresh Devices');
        refreshItem.add_child(new St.Widget({
            x_expand: true
        }))
        refreshItem.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            // style_class: 'popup-menu-icon',
        }));

        ;

        refreshItem.connect('activate', () => {
            this._scanning = true;
            this.refreshDevices(true);
        });
        this._deviceSection.addMenuItem(refreshItem);

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
            let cameraToggle = new PopupMenu.PopupSwitchMenuItem('Use as webcam', false);
            cameraToggle.insert_child_at_index(new St.Icon({
                icon_name: 'camera-video-symbolic',
                style_class: 'popup-menu-icon',
            }), 0);
            cameraToggle.connect('toggled', (item, state) => {
                if (state) {
                    Scrcpy.startCamera(deviceId, this._getDeviceProcesses(deviceId));
                } else {
                    this._stopCamera(deviceId);
                }
            });

            /* ---------- Mirror ---------- */
            let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror', false);
            mirrorToggle.insert_child_at_index(new St.Icon({
                icon_name: 'video-display-symbolic',
                style_class: 'popup-menu-icon',
            }), 0);
            mirrorToggle.connect('toggled', (item, state) => {
                if (state) {
                    Scrcpy.startMirroring(deviceId, this._getDeviceProcesses(deviceId));
                } else {
                    this._stopMirror(deviceId);
                }
            });

            /* ---------- Notifications ---------- */
            // let notifToggle = new PopupMenu.PopupSwitchMenuItem('Notifications', false);
            // notifToggle.connect('toggled', (item, state) => {
            //     if (state) {
            //         Scrcpy.startNotificationListener(deviceId, this._getDeviceProcesses(deviceId));
            //     } else {
            //         this._stopNotificationListener(deviceId);
            //     }
            // });

            deviceSubMenu.menu.addMenuItem(cameraToggle);
            deviceSubMenu.menu.addMenuItem(mirrorToggle);
            // deviceSubMenu.menu.addMenuItem(notifToggle);
            this._deviceSection.addMenuItem(deviceSubMenu);
        });


    }

    /* ===============================
       Process helpers
    =================================*/
    _getDeviceProcesses(deviceId) {
        if (!this._activeProcesses.has(deviceId)) {
            this._activeProcesses.set(deviceId, { camera: null, mirror: null, notifications: null });
        }
        return this._activeProcesses.get(deviceId);
    }

    _stopCamera(deviceId) {
        let procs = this._getDeviceProcesses(deviceId);
        if (procs?.camera) {
            procs.camera.force_exit();
            procs.camera = null;
        }
    }

    _stopMirror(deviceId) {
        let procs = this._getDeviceProcesses(deviceId);
        if (procs?.mirror) {
            procs.mirror.force_exit();
            procs.mirror = null;
        }
    }

    _stopNotificationListener(deviceId) {
        let procs = this._getDeviceProcesses(deviceId);
        if (procs?.notifications) {
            procs.notifications.force_exit();
            procs.notifications = null;
        }
    }

    stopAllProcesses() {
        for (let [, procs] of this._activeProcesses) {
            if (procs.camera) procs.camera.force_exit();
            if (procs.mirror) procs.mirror.force_exit();
            if (procs.notifications) procs.notifications.force_exit();
        }
        this._activeProcesses.clear();
        this._scanning = true;
    }
});

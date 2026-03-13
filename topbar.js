import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Settings from './settings.js';
import * as Scrcpy from './scrcpy.js';
import * as Adb from './adb.js';
import * as Mount from './mount.js';

export const PhoneHubTopBarMenu = GObject.registerClass({
    GTypeName: 'PhoneHubTopBarMenu',
}, class PhoneHubTopBarMenu extends PanelMenu.Button {

    _init() {
        // 0.0 is the alignment (center)
        super._init(0.5, 'Phone HUB', false);
        this.menu.box.set_style('min-width: 330px;');

        // Add a Phone icon and Label to the top bar
        let hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        // Row: Icon + Name
        let leftBox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this._icon = new St.Icon({
            icon_name: 'phone-symbolic',
            style_class: 'system-status-icon',
        });
        this._deviceLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 2px; margin-right: 6px;'
        });
        leftBox.add_child(this._icon);
        leftBox.add_child(this._deviceLabel);

        // Row: Status Icons (mirroring the menu's iconsBox)
        let rightBox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        this._topNetworkTypeLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.8em; margin-right: 4px; font-weight: bold; opacity: 1;'
        });

        this._topBluetoothIcon = new St.Icon({
            icon_name: 'bluetooth-active-symbolic',
            style_class: 'system-status-icon',
            opacity: 120,
            style: "font-size: 0.9em; margin-right: 4px;"
        });

        this._topDataIcon = new St.Icon({
            icon_name: 'network-cellular-offline-symbolic',
            style_class: 'system-status-icon',
            opacity: 120,
            style: "font-size: 0.9em; margin-right: 4px;"
        });

        this._topBatteryLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.9em; margin-right: 0px; opacity: 0.8;'
        });

        this._topBatteryIcon = new St.Icon({
            icon_name: 'battery-missing-symbolic',
            style_class: 'system-status-icon',
            opacity: 180
        });

        rightBox.add_child(this._topNetworkTypeLabel);
        rightBox.add_child(this._topBluetoothIcon);
        rightBox.add_child(this._topDataIcon);
        rightBox.add_child(this._topBatteryLabel);
        // rightBox.add_child(this._topBatteryIcon);

        hbox.add_child(leftBox);
        hbox.add_child(rightBox);
        this.add_child(hbox);

        // Hide by default initially
        this.hide();
        this._toggleRef = null;
    }

    setToggleReference(toggle) {
        this._toggleRef = toggle;
    }

    updateVisibility(isConnected) {
        if (isConnected) {
            this.show();
        } else {
            this.hide();
            this.menu.removeAll();
        }
    }



    getFindMyPhoneItem(isPaired, deviceId, isNetwork) {
        this._isRinging = this._isRinging || false;
        let findPhoneItem = new PopupMenu.PopupMenuItem(this._isRinging ? 'Stop Ringing Phone' : 'Find My Phone');
        const icon = new St.Icon({
            icon_name: this._isRinging ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
            style_class: 'popup-menu-icon',
        });
        findPhoneItem.insert_child_at_index(icon, 0);

        if (!isPaired) {
            findPhoneItem.sensitive = false;
        }

        findPhoneItem.connect('activate', async () => {
            const s = Settings.loadSettings();
            let ip = s.phoneIp;
            if (!ip) {
                ip = isNetwork ? deviceId : null;
                if (!isNetwork) {
                    const ips = await Adb.getDeviceIps(deviceId);
                    ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                }
            }

            if (!ip) return;

            const token = s.restToken;
            const action = this._isRinging ? 'stop' : 'start';

            try {
                const message = Soup.Message.new('POST', `http://${ip}:8080/ring?token=${token}&action=${action}`);
                const session = new Soup.Session();
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        let decoder = new TextDecoder();
                        let text = decoder.decode(bytes.get_data ? bytes.get_data() : bytes.toArray());
                        let data = JSON.parse(text);

                        if (data.status === "ringing") {
                            this.setRingingState(true);
                            if (this._toggleRef && this._toggleRef.setRingingState) {
                                this._toggleRef.setRingingState(true);
                            }
                        } else if (data.status === "stopped") {
                            this.setRingingState(false);
                            if (this._toggleRef && this._toggleRef.setRingingState) {
                                this._toggleRef.setRingingState(false);
                            }
                        }
                    } catch (e) {
                        console.error(`Find My Phone Error: ${e.message}`);
                    }
                });
            } catch (e) {
                console.error(`Find My Phone Error: ${e.message}`);
            }
        });

        this._updateFindPhoneUI = () => {
            if (this._isRinging) {
                findPhoneItem.label.text = 'Stop Ringing Phone';
                icon.icon_name = 'audio-volume-muted-symbolic';
            } else {
                findPhoneItem.label.text = 'Find My Phone';
                icon.icon_name = 'audio-volume-high-symbolic';
            }
        };

        return findPhoneItem;
    }

    setRingingState(state) {
        this._isRinging = state;
        if (this._updateFindPhoneUI) {
            this._updateFindPhoneUI();
        }
    }

    resetFindPhone() {
        this.setRingingState(false);
    }

    async rebuildMenu(deviceId, deviceName, isPaired, isNetwork) {
        this.menu.removeAll();
        if (!isPaired) {
            let item = new PopupMenu.PopupMenuItem('Device Unpaired');
            item.sensitive = false;
            this.menu.addMenuItem(item);
            this._deviceLabel.set_text('');
            return;
        }

        // Update the top bar label with the device name
        this._deviceLabel.set_text(deviceName);

        const hasScrcpy = Scrcpy.checkScrcpy();
        const settings = Settings.loadSettings();



        /* ---------- SSHFS Mount ---------- */
        const mountPoint = settings.sshfsMountPoint;
        this._mountToggle = new PopupMenu.PopupSwitchMenuItem('Mount Files', Mount.isMounted(mountPoint),);
        let mountToggle = this._mountToggle;
        mountToggle.insert_child_at_index(new St.Icon({
            icon_name: 'folder-remote-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        if (!Mount.checkSshfs()) {
            mountToggle.sensitive = false;
            mountToggle.label.text += ' (sshfs missing)';
        }
        mountToggle.connect('toggled', async (item, state) => {
            if (state) {
                try {
                    const s = Settings.loadSettings();
                    let ip = s.phoneIp;

                    if (!ip) {
                        ip = isNetwork ? deviceId : null;
                        if (!isNetwork) {
                            const ips = await Adb.getDeviceIps(deviceId);
                            ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                        }
                    }
                    if (!ip) throw new Error("Could not find device IP");

                    await Mount.mountDevice(ip, s);
                    Main.notify("Phone HUB", "Phone files mounted at " + mountPoint);
                    if (this._toggleRef) this._toggleRef.syncMountState(true);
                } catch (e) {
                    Main.notify("Phone HUB", "Failed to mount: " + e.message);
                    mountToggle.setToggleState(false);
                }
            } else {
                try {
                    await Mount.unmountDevice(mountPoint);
                    Main.notify("Phone HUB", "Phone files unmounted");
                    if (this._toggleRef) this._toggleRef.syncMountState(false);
                } catch (e) {
                    Main.notify("Phone HUB", "Failed to unmount: " + e.message);
                    mountToggle.setToggleState(true);
                }
            }
        });
        this.menu.addMenuItem(mountToggle);

        /* ---------- Call Notifications ---------- */
        let callNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Call Notifications',
            settings.enableCallNotifications !== false
        );
        callNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'call-incoming-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        callNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enableCallNotifications = state;
            Settings.saveSettings(s);
            if (this._toggleRef) {
                if (state) this._toggleRef._startCallPolling();
                else this._toggleRef._stopCallPolling();
            }
        });
        this.menu.addMenuItem(callNotifToggle);

        /* ---------- Sync Notifications ---------- */
        let phoneNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Sync Notifications',
            settings.enablePhoneNotifications !== false
        );
        phoneNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'mail-unread-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        phoneNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enablePhoneNotifications = state;
            Settings.saveSettings(s);
            if (this._toggleRef) {
                if (state) this._toggleRef._startNotificationPolling();
                else {
                    this._toggleRef._stopNotificationPolling();
                    this._toggleRef._notifiedIds.clear();
                }
            }
        });
        this.menu.addMenuItem(phoneNotifToggle);

        /* ---------- Find My Phone ---------- */
        let findPhoneItem = this.getFindMyPhoneItem(isPaired, deviceId, isNetwork);
        this.menu.addMenuItem(findPhoneItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* ---------- Camera Toggle ---------- */
        let cameraToggle = new PopupMenu.PopupSwitchMenuItem('Use as webcam', false);
        cameraToggle.insert_child_at_index(new St.Icon({
            icon_name: 'camera-video-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        if (!hasScrcpy || isNetwork) {
            cameraToggle.sensitive = false;
            if (!hasScrcpy) cameraToggle.label.text += ' (scrcpy missing)';
            else if (isNetwork) cameraToggle.label.text += ' (USB only)';
        }
        cameraToggle.connect('toggled', (item, state) => {
            if (this._toggleRef) {
                if (state) Scrcpy.startCamera(deviceId, this._toggleRef._getDeviceProcesses(deviceId));
                else this._toggleRef._stopCamera(deviceId);
            }
        });
        this.menu.addMenuItem(cameraToggle);

        /* ---------- Mirror Toggle ---------- */
        let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror Display', false);
        mirrorToggle.insert_child_at_index(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        if (!hasScrcpy || isNetwork) {
            mirrorToggle.sensitive = false;
            if (!hasScrcpy) mirrorToggle.label.text += ' (scrcpy missing)';
            else if (isNetwork) mirrorToggle.label.text += ' (USB only)';
        }
        mirrorToggle.connect('toggled', (item, state) => {
            if (this._toggleRef) {
                if (state) Scrcpy.startMirroring(deviceId, this._toggleRef._getDeviceProcesses(deviceId));
                else this._toggleRef._stopMirror(deviceId);
            }
        });
        this.menu.addMenuItem(mirrorToggle);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* ---------- Unpair Action ---------- */
        let unpairItem = new PopupMenu.PopupMenuItem('Unpair Device');
        unpairItem.insert_child_at_index(new St.Icon({
            icon_name: 'user-trash-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        unpairItem.style = 'color: #ed333b;';
        unpairItem.connect('activate', () => {
            if (this._toggleRef) this._toggleRef._forgetDevice();
        });
        this.menu.addMenuItem(unpairItem);
    }

    syncMountState(state) {
        if (this._mountToggle && this._mountToggle.state !== state) {
            this._mountToggle.setToggleState(state);
        }
    }

    updateBattery(level, iconName) {
        const text = `${level}%`;
        if (this._topBatteryLabel) this._topBatteryLabel.text = text;
        if (this._topBatteryIcon) this._topBatteryIcon.icon_name = iconName;
        if (this._menuBatteryLabel) this._menuBatteryLabel.text = text;
        if (this._menuBatteryIcon) this._menuBatteryIcon.icon_name = iconName;
    }

    updateDataStatus(status, iconName, operator, networkType) {
        if (this._topDataIcon) {
            this._topDataIcon.icon_name = iconName;
            this._topDataIcon.opacity = status === 'on' ? 255 : 120;
        }
        if (this._menuDataIcon) {
            this._menuDataIcon.icon_name = iconName;
            this._menuDataIcon.opacity = status === 'on' ? 255 : 120;
        }
        if (this._menuOperatorLabel) {
            this._menuOperatorLabel.text = operator || (status === 'on' ? 'Mobile Network' : 'Disconnected');
        }
        if (this._menuNetworkTypeLabel) {
            this._menuNetworkTypeLabel.text = status === 'on' ? networkType : '';
        }
        if (this._topNetworkTypeLabel) {
            this._topNetworkTypeLabel.text = status === 'on' ? networkType : '';
        }
    }

    updateBluetoothStatus(status) {
        const iconName = status === 'on'
            ? 'bluetooth-active-symbolic'
            : 'bluetooth-disabled-symbolic';

        if (this._menuBluetoothIcon) {
            this._menuBluetoothIcon.icon_name = iconName;
            this._menuBluetoothIcon.opacity = status === 'on' ? 255 : 120;
        }
        if (this._topBluetoothIcon) {
            this._topBluetoothIcon.icon_name = iconName;
            this._topBluetoothIcon.opacity = status === 'on' ? 255 : 120;
        }
    }
});

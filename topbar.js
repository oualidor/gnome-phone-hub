import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Settings from './settings.js';
import * as Scrcpy from './scrcpy.js';
import * as Adb from './adb.js';

export const PhoneHubTopBarMenu = GObject.registerClass({
    GTypeName: 'PhoneHubTopBarMenu',
}, class PhoneHubTopBarMenu extends PanelMenu.Button {

    _init() {
        // 0.0 is the alignment (center)
        super._init(0.5, 'Phone HUB', false);

        // Add a Phone icon and Label to the top bar
        let hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this._icon = new St.Icon({
            icon_name: 'phone-symbolic',
            style_class: 'system-status-icon',
        });

        this._deviceLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-left: 2px; margin-right: 4px;'
        });

        hbox.add_child(this._icon);
        hbox.add_child(this._deviceLabel);
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

        // 1. Header label
        let titleItem = new PopupMenu.PopupMenuItem(`${deviceName}`);
        titleItem.sensitive = false;
        titleItem.label.add_style_class_name('bold');
        this.menu.addMenuItem(titleItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 2. Camera Toggle
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

        // 3. Mirror Toggle
        let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror', false);
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

        // 4. SMS Item
        let smsItem = new PopupMenu.PopupMenuItem('View SMS Messages');
        smsItem.insert_child_at_index(new St.Icon({
            icon_name: 'chat-message-new-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        smsItem.connect('activate', async () => {
            // Re-use logic to pop open the GTK window
            if (!this._toggleRef) return;
            try {
                let ip = isNetwork ? deviceId : null;
                if (!isNetwork) {
                    const ips = await Adb.getDeviceIps(deviceId);
                    ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                }
                const extensionPath = Main.extensionManager.lookup('phone-hub@oualidkhial').path;
                const scriptPath = `${extensionPath}/smsWindow.js`;

                let argv = ['gjs', '-m', scriptPath];
                if (ip) argv.push('--host', ip);

                import('gi://Gio').then(GioMod => {
                    const Gio = GioMod.default;
                    Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
                });
            } catch (e) { console.error(e); }
        });

        // 5. Call Notifications
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

        // 6. Sync Notifications
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

        // 7. Unpair Action
        let unpairItem = new PopupMenu.PopupMenuItem('Unpair Device');
        unpairItem.insert_child_at_index(new St.Icon({
            icon_name: 'user-trash-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        unpairItem.connect('activate', () => {
            if (this._toggleRef) this._toggleRef._forgetDevice();
        });

        // this.menu.addMenuItem(smsItem);
        this.menu.addMenuItem(callNotifToggle);
        this.menu.addMenuItem(phoneNotifToggle);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(cameraToggle);
        this.menu.addMenuItem(mirrorToggle);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(unpairItem);
    }
});

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




    async rebuildMenu(deviceId, deviceName, isPaired, isNetwork) {
        try {
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



            /* ---------- Toggles from Main Extension Logic ---------- */
            if (this._toggleRef) {
                let mountToggle = this._toggleRef.getMountToogle(isPaired, isNetwork, deviceId);
                this.menu.addMenuItem(mountToggle);

                let callNotifToggle = this._toggleRef.getCallNotifToggle();
                this.menu.addMenuItem(callNotifToggle);

                let phoneNotifToggle = this._toggleRef.getPhoneNotificationsToggle();
                this.menu.addMenuItem(phoneNotifToggle);

                let findPhoneItem = this._toggleRef.getFindMyPhoneItem(isPaired, deviceId, isNetwork);
                this.menu.addMenuItem(findPhoneItem);

                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                let cameraToggle = this._toggleRef.getCameraToggle(isPaired, isNetwork, deviceId, hasScrcpy);
                this.menu.addMenuItem(cameraToggle);

                let mirrorToggle = this._toggleRef.getMirrorToggle(isPaired, isNetwork, deviceId, hasScrcpy);
                this.menu.addMenuItem(mirrorToggle);
            }

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
        } catch (e) {
            console.error(e)
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

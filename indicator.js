import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { PhoneHubToggle } from './toggle.js';
import { PhoneHubTopBarMenu } from './topbar.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

export const PhoneHubIndicator = GObject.registerClass({
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

        // Top Bar Menu
        this._topBarMenu = new PhoneHubTopBarMenu();
        this._topBarMenu.setToggleReference(this._toggle);
        this._toggle._topBarRef = this._topBarMenu; // Inject reference so toggle can drive it
        Main.panel.addToStatusArea('PhoneHubTopBar', this._topBarMenu);

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            5000,
            () => {
                if (this._toggle.checked) {
                    this._toggle.refreshDevices();
                }
                return true;
            }
        );
    }

    destroy() {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._toggle.stopAllProcesses();

        if (this._topBarMenu) {
            this._topBarMenu.destroy();
            this._topBarMenu = null;
        }

        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        super.destroy();
    }
});

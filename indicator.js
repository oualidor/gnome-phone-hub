import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { PhoneHubToggle } from './toggle.js';

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

        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        super.destroy();
    }
});

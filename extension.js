import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PhoneHubIndicator } from './indicator.js';

export default class PhoneHubExtension extends Extension {

    enable() {
        this._indicator = new PhoneHubIndicator();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
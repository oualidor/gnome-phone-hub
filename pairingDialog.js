import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as Scanner from './scanner.js';

const SoupSession = new Soup.Session();

export const PairingDialog = GObject.registerClass({
    GTypeName: 'PairingDialog',
}, class PairingDialog extends ModalDialog.ModalDialog {

    _init(callback) {
        super._init({
            styleClass: 'pairing-dialog',
            destroyOnClose: true,
        });

        this._callback = callback;

        const mainBox = new St.BoxLayout({
            vertical: true,
            style: 'padding: 20px; spacing: 15px; width: 350px;',
        });
        this.contentLayout.add_child(mainBox);

        const title = new St.Label({
            text: 'Pair New Device',
            style: 'font-weight: bold; font-size: 1.2em;',
        });
        mainBox.add_child(title);

        // --- Discovery Section ---
        this._discoveryBox = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 10px;',
        });
        mainBox.add_child(this._discoveryBox);

        this._discoveryLabel = new St.Label({
            text: 'Scanning network for phones...',
            style: 'font-size: 0.9em; color: #aaa;',
        });
        this._discoveryBox.add_child(this._discoveryLabel);

        this._deviceList = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 5px;',
        });
        this._discoveryBox.add_child(this._deviceList);

        // --- Manual Section ---
        const separator = new St.Widget({
            style: 'height: 1px; background-color: #444; margin: 10px 0;',
        });
        mainBox.add_child(separator);

        const manualTitle = new St.Label({
            text: 'Or enter IP manually:',
            style: 'font-size: 0.9em; font-weight: bold;',
        });
        mainBox.add_child(manualTitle);

        this._entry = new St.Entry({
            hint_text: '192.168.1.XX',
            can_focus: true,
            style: 'padding: 8px;',
        });
        mainBox.add_child(this._entry);

        this._statusLabel = new St.Label({
            text: '',
            style: 'font-size: 0.8em; color: #ffaa00;',
        });
        mainBox.add_child(this._statusLabel);

        this.setButtons([
            {
                label: 'Cancel',
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: 'Pair Manually',
                action: () => this._onPairRequested(this._entry.get_text().trim()),
                key: Clutter.KEY_Return,
            },
        ]);

        this._startDiscovery();
    }

    async _startDiscovery() {
        try {
            const subnet = await Scanner.findLocalSubnet();
            if (!subnet) {
                this._discoveryLabel.text = 'Could not detect local network.';
                return;
            }

            const devices = await Scanner.scanNetwork(subnet);
            this._deviceList.destroy_all_children();

            if (devices.length === 0) {
                this._discoveryLabel.text = 'No phones found on network.';
                const retryBtn = new St.Button({
                    label: 'Retry Scan',
                    style_class: 'button',
                    style: 'margin-top: 5px; padding: 5px;',
                });
                retryBtn.connect('clicked', () => {
                    this._discoveryLabel.text = 'Scanning...';
                    this._startDiscovery();
                });
                this._deviceList.add_child(retryBtn);
            } else {
                this._discoveryLabel.text = 'Discovered phones:';
                devices.forEach(ip => {
                    const btn = new St.Button({
                        label: `Phone at ${ip}`,
                        style_class: 'button',
                        style: 'text-align: left; padding: 10px; background-color: #333; margin-bottom: 2px;',
                        x_expand: true,
                    });
                    btn.connect('clicked', () => this._onPairRequested(ip));
                    this._deviceList.add_child(btn);
                });
            }
        } catch (e) {
            this._discoveryLabel.text = `Scan error: ${e.message}`;
        }
    }

    async _onPairRequested(ip) {
        if (!ip) return;

        this._statusLabel.text = `Sending pairing request to ${ip}...`;

        try {
            const message = Soup.Message.new('POST', `http://${ip}:8080/pair`);
            SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        this._statusLabel.text = 'Pending... Accept on your phone.';
                        this._startPolling(ip);
                    } else {
                        this._statusLabel.text = 'Error: Server not reachable.';
                    }
                } catch (e) {
                    this._statusLabel.text = `Error: ${e.message}`;
                }
            });
        } catch (e) {
            this._statusLabel.text = `Error: ${e.message}`;
        }
    }

    _startPolling(ip) {
        if (this._pollTimerId) {
            GLib.Source.remove(this._pollTimerId);
        }

        this._pollCount = 0;
        this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (this._pollCount > 30) {
                this._statusLabel.text = 'Pairing timed out.';
                return GLib.SOURCE_REMOVE;
            }
            this._pollCount++;

            this._checkStatus(ip);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _checkStatus(ip) {
        console.log(`PairingDialog: Checking status for ${ip}...`);
        const message = Soup.Message.new('GET', `http://${ip}:8080/`);
        SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.status_code === 200) {
                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.toArray());
                    console.log(`PairingDialog: Server response: ${text}`);
                    const status = JSON.parse(text);
                    if (status.authorized) {
                        console.log('PairingDialog: Device AUTHORIZED!');
                        if (this._pollTimerId) {
                            GLib.Source.remove(this._pollTimerId);
                            this._pollTimerId = null;
                        }
                        this._statusLabel.text = 'Successfully paired!';
                        if (this._callback) this._callback(ip);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                            this.close();
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        console.log('PairingDialog: Still pending authorization...');
                    }
                } else {
                    console.warn(`PairingDialog: Unexpected status code ${message.status_code}`);
                }
            } catch (e) {
                console.error(`PairingDialog Status Check Error: ${e.message}`);
            }
        });
    }

    close() {
        if (this._pollTimerId) {
            GLib.Source.remove(this._pollTimerId);
            this._pollTimerId = null;
        }
        super.close();
    }
});

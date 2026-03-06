import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import * as Scanner from './scanner.js';
import { PairingServer } from './pairingServer.js';

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
            text: 'Scan this QR code with the Phone HUB app:',
            style: 'font-size: 1.0em; color: #eee; text-align: center;',
        });
        this._discoveryBox.add_child(this._discoveryLabel);

        this._qrBin = new St.Bin({
            style: 'background-color: white; padding: 10px; margin: 10px auto; border-radius: 5px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._discoveryBox.add_child(this._qrBin);

        this._qrImage = new St.Icon({
            icon_size: 200,
            style: 'color: black;', // Some themes might invert it otherwise
        });
        this._qrBin.set_child(this._qrImage);

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

        this._setupPairing();
    }

    async _setupPairing() {
        this._pairingServer = new PairingServer((phoneIp) => {
            this._onPairRequested(phoneIp);
        });

        if (this._pairingServer.start()) {
            const subnet = await Scanner.findLocalSubnet();
            const pcIp = subnet ? subnet.ip : '127.0.0.1';

            // Generate QR Code URL
            // phonehub://pair?ip=PC_IP&port=8081
            const pairingData = encodeURIComponent(`phonehub://pair?ip=${pcIp}&port=8081`);
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${pairingData}`;

            console.log(`PairingDialog: PC IP is ${pcIp}, loading QR from ${qrUrl}`);

            const message = Soup.Message.new('GET', qrUrl);
            SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
                        const gicon = Gio.BytesIcon.new(bytes);
                        this._qrImage.gicon = gicon;
                    } else {
                        this._discoveryLabel.text = 'Failed to load QR code. check internet.';
                    }
                } catch (e) {
                    this._discoveryLabel.text = `QR Error: ${e.message}`;
                }
            });
        } else {
            this._discoveryLabel.text = 'Could not start pairing server.';
        }
    }

    async _onPairRequested(ip) {
        if (!ip) return;

        this._statusLabel.text = `Sending pairing request to ${ip}...`;

        try {
            const hostname = GLib.get_host_name();
            const message = Soup.Message.new('POST', `http://${ip}:8080/pair?deviceName=${encodeURIComponent(hostname)}`);
            SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        const decoder = new TextDecoder('utf-8');
                        const text = decoder.decode(bytes.toArray());
                        const response = JSON.parse(text);
                        this._pendingRestToken = response.restToken;
                        this._pendingWsToken = response.wsToken;

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
                        if (this._callback) this._callback(ip, this._pendingRestToken, this._pendingWsToken);
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
        if (this._pairingServer) {
            this._pairingServer.stop();
        }
        super.close();
    }
});

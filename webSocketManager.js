import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import * as Settings from './settings.js';
import * as Bluetooth from './bluetooth.js';

const SoupSession = new Soup.Session({ timeout: 5 });

export const WebSocketManager = GObject.registerClass({
    GTypeName: 'PhoneHubWebSocketManager',
    Signals: {
        'connected': { param_types: [GObject.TYPE_STRING] },
        'disconnected': { param_types: [] },
        'message': { param_types: [GObject.TYPE_STRING] },
        'reconnect-update': { param_types: [GObject.TYPE_INT, GObject.TYPE_STRING] }, // countdown, ip
        'reconnect-cleared': { param_types: [] },
        'connecting': { param_types: [] },
    },
}, class WebSocketManager extends GObject.Object {

    _init() {
        super._init();
        this._wsConnection = null;
        this._wsIp = null;
        this._isConnecting = false;
        this._isConnected = false;
        this._reconnectCountdown = 2;
        this._reconnectTimerId = null;
        this._reconnectIp = null;
        this._wsCancellable = null;
        this._wsPingTimer = null;
        this._reconnectFailures = 0;
        this._btLookupInProgress = false;
        this._pendingRequests = new Map();
        this._reqIdCounter = 0;
    }

    get isConnected() {
        return this._isConnected;
    }

    get isConnecting() {
        return this._isConnecting;
    }

    get reconnectCountdown() {
        return this._reconnectCountdown;
    }

    get reconnectTimerId() {
        return this._reconnectTimerId;
    }

    get ip() {
        return this._wsIp;
    }

    openConnection(ip) {
        if (this._wsConnection || this._isConnecting || !ip) return;

        console.log(`Phone HUB: WebSocketManager connecting to ${ip}, previous failures ${this._reconnectFailures}`);
        this._wsIp = ip;
        this._isConnecting = true;
        this.emit('connecting');

        const s = Settings.loadSettings();
        const url = s.wsToken ? `ws://${ip}:8080/ws?token=${s.wsToken}` : `ws://${ip}:8080/ws`;
        const message = Soup.Message.new('GET', url);
        const cancellable = new Gio.Cancellable();
        this._wsCancellable = cancellable;

        // Hard abort after 5 seconds
        const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (!this._wsConnection) {
                this._isConnecting = false;
                cancellable.cancel();
            }
            return GLib.SOURCE_REMOVE;
        });

        SoupSession.websocket_connect_async(message, null, null, null, cancellable, (session, res) => {
            GLib.source_remove(timerId);
            this._isConnecting = false;
            try {
                this._wsConnection = session.websocket_connect_finish(res);
                console.log(`Phone HUB: WebSocketManager connected to ${ip}`);

                this.clearReconnectTimer();
                this._reconnectFailures = 0;

                this._wsConnection.connect('message', (ws, type, message) => {
                    this._onMessage(type, message);
                });

                this._wsConnection.connect('closed', (ws) => {
                    this._onClosed(ws);
                });

                this._isConnected = true;
                this.emit('connected', ip);

            } catch (e) {
                console.error(`Phone HUB: WebSocket connection failed: ${e.message}`);
                this._isConnected = false;
                this._isConnecting = false;
                this._reconnectFailures++;
                // this.emit('disconnected');
                if (this._reconnectFailures > 2) {
                    console.log(`Phone HUB: WebSocketManager connection not available, switchin to bleutouht lookup`);
                    this._tryBluetoothIpLookup(ip);
                } else {
                    this.openConnection(ip)
                }

                // this.startReconnectCountdown(ip);
            }
        });
    }

    sendRequest(type, data = {}) {
        if (!this._wsConnection || !this._isConnected) {
            return Promise.reject(new Error("WebSocket not connected"));
        }

        const reqId = `req_${Date.now()}_${this._reqIdCounter++}`;
        const message = JSON.stringify({
            type,
            reqId,
            ...data
        });

        return new Promise((resolve, reject) => {
            const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                const req = this._pendingRequests.get(reqId);
                if (req) {
                    console.error(`Phone HUB WS: Request ${type} (${reqId}) timed out`);
                    this._pendingRequests.delete(reqId);
                    reject(new Error(`Request ${type} timed out`));
                }
                return GLib.SOURCE_REMOVE;
            });

            this._pendingRequests.set(reqId, { resolve, reject, timeoutId });

            try {
                this._wsConnection.send_text(message);
                console.log(`Phone HUB WS: Sent request ${type} (${reqId})`);
            } catch (e) {
                GLib.source_remove(timeoutId);
                this._pendingRequests.delete(reqId);
                reject(e);
            }
        });
    }

    closeConnection() {
        console.log("Phone HUB: WebSocketManager disconnecting");
        this._wsIp = null;
        this._reconnectFailures = 0;
        this.clearReconnectTimer();

        if (this._wsPingTimer) {
            GLib.source_remove(this._wsPingTimer);
            this._wsPingTimer = null;
        }
        if (this._wsConnection) {
            this._wsConnection.close(Soup.WebsocketCloseCode.NORMAL, "User disconnected");
            this._wsConnection = null;
        }
        this._isConnected = false;
        this._isConnecting = false;
    }

    _onClosed(ws) {
        console.log("Phone HUB: WebSocketManager closed.");

        if (ws && ws.get_close_code() === Soup.WebsocketCloseCode.POLICY_VIOLATION) {
            this.emit('message', JSON.stringify({ type: 'UNPAIR' }));
            return;
        }

        if (this._wsPingTimer) {
            GLib.source_remove(this._wsPingTimer);
            this._wsPingTimer = null;
        }

        const oldIp = this._wsIp;
        this._wsConnection = null;
        this._isConnected = false;
        this._isConnecting = false;

        this.emit('disconnected');

        const ip = oldIp || Settings.loadSettings().phoneIp;
        if (ip) {
            this._reconnectFailures++;
            this.startReconnectCountdown(ip);
        }
    }

    _onMessage(type, message) {
        if (type !== Soup.WebsocketDataType.TEXT) return;
        try {
            const text = new TextDecoder().decode(message.toArray());
            const data = JSON.parse(text);

            if (this._wsPingTimer) {
                GLib.source_remove(this._wsPingTimer);
            }
            this._wsPingTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                console.log("Phone HUB: WebSocket ping timeout");
                if (this._wsConnection) {
                    this._wsConnection.close(Soup.WebsocketCloseCode.ABNORMAL, "Ping timeout");
                }
                this._onClosed();
                return GLib.SOURCE_REMOVE;
            });


            if (data.type === "PING") {
                if (this._wsConnection) {
                    this._wsConnection.send_text("{\"type\":\"PONG\"}");
                }
            } else if (data.reqId && this._pendingRequests.has(data.reqId)) {
                console.log(`Phone HUB WS: Received response for ${data.reqId}`);
                const { resolve, timeoutId } = this._pendingRequests.get(data.reqId);
                GLib.source_remove(timeoutId);
                this._pendingRequests.delete(data.reqId);
                resolve(data);
            } else {
                this.emit('message', text);
            }
        } catch (e) {
            console.error(`Phone HUB: WebSocket Parse Error: ${e.message}`);
        }
    }

    clearReconnectTimer() {
        if (this._reconnectTimerId) {
            if (typeof this._reconnectTimerId === 'number' && this._reconnectTimerId > 0) {
                GLib.source_remove(this._reconnectTimerId);
            }
            this._reconnectTimerId = null;
        }
        this._reconnectCountdown = 10;
        this.emit('reconnect-cleared');
    }

    startReconnectCountdown(ip) {
        if (!ip) return;
        if (this._reconnectTimerId && this._reconnectIp === ip) return;


        this.clearReconnectTimer();
        this._reconnectIp = ip;
        this._reconnectCountdown = 10;

        console.log(`Phone HUB: Starting reconnection countdown for ${ip} (failures: ${this._reconnectFailures})`);

        this._reconnectTimerId = -1;
        this.emit('reconnect-update', this._reconnectCountdown, ip);

        this._reconnectTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._reconnectCountdown--;

            if (this._reconnectCountdown <= 0) {
                this._reconnectTimerId = null;
                console.log(`Phone HUB: Reconnecting to ${ip}`);
                this.openConnection(ip);
                return GLib.SOURCE_REMOVE;
            }

            this.emit('reconnect-update', this._reconnectCountdown, ip);
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _tryBluetoothIpLookup(currentIp) {
        const s = Settings.loadSettings();
        const deviceName = s.deviceName;
        this._btLookupInProgress = true;


        if (!deviceName || deviceName === 'Paired Phone') {
            console.log("Phone HUB: No specific device name saved, skipping BT IP lookup.");
            this.startReconnectCountdown(currentIp)
            return;
        }

        console.log(`Phone HUB: Device name foud, attempting Bluetooth IP lookup for device: "${deviceName}"`);

        try {
            // Look up the phone's real BT MAC from BlueZ paired devices by name
            let btMac = await Bluetooth.findPhoneBtMac(deviceName);

            // Phone foudn with reack Mac adress
            if (!btMac && btMac !== '02:00:00:00:00:00') {
                console.log("Phone HUB: Could not determine phone BT MAC, skipping.");
                this.startReconnectCountdown(currentIp)
                return;
            }



            // Fall back to saved phoneBtMac if BlueZ lookup didn't find it
            // if (!btMac && s.phoneBtMac && s.phoneBtMac !== '02:00:00:00:00:00') {
            //     btMac = s.phoneBtMac;
            //     this.startReconnectCountdown(currentIp)
            //     console.log(`Phone HUB: Using saved BT MAC: ${btMac}`);
            //     return
            // }



            // Save the real BT MAC for future use
            if (btMac !== s.phoneBtMac) {
                console.log(`Phone HUB: Saving new BT MAC: ${btMac}`);
                s.phoneBtMac = btMac;
                Settings.saveSettings(s);
            }

            const newIp = await Bluetooth.requestIpViaBluetooth(btMac);
            if (newIp && newIp !== '127.0.0.1' && newIp !== '0.0.0.0' && newIp !== currentIp) {
                console.log(`Phone HUB: Bluetooth resolved new IP: ${newIp} (was ${currentIp})`);
                s.phoneIp = newIp;
                Settings.saveSettings(s);
                this.clearReconnectTimer();
                this._reconnectFailures = 0;
                this._reconnectIp = null;
                this.openConnection(newIp);
            } else {
                console.log("Phone HUB: Bluetooth IP lookup returned null.");
                this.startReconnectCountdown(currentIp)
            }

            this._btLookupInProgress = false;


        } catch (e) {
            console.error(`Phone HUB: Bluetooth IP lookup error: ${e.message}`);
        } finally {
            this._btLookupInProgress = false;
        }
    }
});

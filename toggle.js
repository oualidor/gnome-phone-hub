import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import St from 'gi://St';
import * as Adb from './adb.js';
import * as Scrcpy from './scrcpy.js';
import * as Settings from './settings.js';
import * as Mount from './mount.js';
import * as ScreenStream from './screenStream.js';
import { PairingDialog } from './pairingDialog.js';

const SoupSession = new Soup.Session({ timeout: 5 });

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

        this._permanentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._permanentSection);


        this._scanning = false;

        // Map<deviceId, {camera: Gio.Subprocess|null, mirror: Gio.Subprocess|null, notifications: Gio.Subprocess|null}>
        this._activeProcesses = new Map();

        this._batteryTimeoutId = null;
        this._lastBatteryLevel = null;
        this._lastDataStatus = null;

        // Call notification state
        this._callPollingId = null;
        this._lastCallStatus = "IDLE";
        this._currentCallNotify = null;

        // Notification syncing state
        this._notificationPollingId = null;
        this._notifiedIds = new Set();
        this._phoneNotificationSource = null;

        // WebSocket state
        this._wsConnection = null;
        this._wsReconnectTimer = null;
        this._wsIp = null;
        this._isConnected = false;
        this._isConnecting = false;

        // Reconnection countdown state
        this._reconnectCountdown = 10;
        this._reconnectTimerId = null;
        this._reconnectIp = null;
        const _initSettings = Settings.loadSettings();
        this._lastKnownDeviceName = _initSettings.deviceName || 'Paired Phone';


        this.connect('notify::checked', () => {
            if (this.checked) {
                this._scanning = true;
                this.subtitle = 'Connecting...';
                this.refreshDevices(true);
            } else {
                this._scanning = false;
                this._disconnectWebSocket();
                this._clearReconnectTimer();
                this._notifiedIds.clear();
                this.stopAllProcesses();
                this._deviceSection.removeAll();
                this.subtitle = 'Disabled';
                this._isConnected = false;


                if (this._topBarRef) this._topBarRef.updateVisibility(false);
            }
        });

        // this.checked = true;
    }


    /* ===============================
       Refresh devices (non-blocking)
    =================================*/
    async refreshDevices(force = false) {
        if (!this.checked) return true;
        if (!this._scanning && !force)
            return true;


        this._scanning = false;
        const settings = Settings.loadSettings();
        const pairedIp = settings.phoneIp;

        // No Phone paired
        if (!pairedIp) {

            this._updateMenu([], null);
            return true;
        }

        // Phone paired but current webSocket Point to another phone
        if (this._wsConnection && this._wsIp !== pairedIp) {

            this._disconnectWebSocket();
        }



        // this._fetchFullStateAndRebuildMenu(pairedIp);


        // Phone paired but no active webSocket connection
        if (!this._wsConnection) {
            console.log("Phone HUB: Connecting to WebSocket at " + pairedIp);
            this._connectWebSocket(pairedIp);
        } else if (force) {
            this._fetchFullStateAndRebuildMenu(pairedIp); cause
        }
        return true;
    }

    /* ===============================
       WebSocket Connection Management
    =================================*/
    _connectWebSocket(ip) {
        console.log("Phone HUB: Connecting to WebSocket ********************************** at " + ip);
        if (this._wsConnection || this._isConnecting) return;
        if (!this.checked) return;
        this._wsIp = ip;
        this._isConnecting = true;
        this.subtitle = 'Connecting...';

        const s = Settings.loadSettings();
        const url = s.wsToken ? `ws://${ip}:8080/ws?token=${s.wsToken}` : `ws://${ip}:8080/ws`;
        const message = Soup.Message.new('GET', url);
        const cancellable = new Gio.Cancellable();
        this._wsCancellable = cancellable;

        // Hard abort after 5 seconds if phone is offline
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
                console.log(`Phone HUB: WebSocket connected to ${ip}`);

                // Clear any pending reconnection timer on success
                this._clearReconnectTimer();


                this._wsConnection.connect('message', (ws, type, message) => {
                    this._onWebSocketMessage(type, message);
                });

                this._wsConnection.connect('closed', (ws) => {
                    this._onWebSocketClosed(ws);
                });

                this._isConnected = true;
                if (this._topBarRef) this._topBarRef.updateVisibility(true);

                // Fetch full menu state immediately upon connection
                this._fetchFullStateAndRebuildMenu(ip);

            } catch (e) {
                console.error(`Phone HUB: WebSocket connection failed: ${e.message}`);
                this._isConnected = false;
                this._isConnecting = false;
                this.subtitle = 'Disconnected';
                this._startReconnectCountdown(ip);
            }
        });
    }

    _disconnectWebSocket() {
        this._wsIp = null;
        this._clearReconnectTimer();
        if (this._wsReconnectTimer) {
            GLib.source_remove(this._wsReconnectTimer);
            this._wsReconnectTimer = null;
        }
        if (this._wsPingTimer) {
            GLib.source_remove(this._wsPingTimer);
            this._wsPingTimer = null;
        }
        if (this._wsConnection) {
            this._wsConnection.close(Soup.WebsocketCloseCode.NORMAL, "User disconnected");
            this._wsConnection = null;
        }
    }

    _onWebSocketClosed(ws) {
        console.log("Phone HUB: WebSocket closed.");

        if (ws && ws.get_close_code() === Soup.WebsocketCloseCode.POLICY_VIOLATION) {
            console.log("Phone HUB: Unpaired from phone side detected.");
            this._forgetDevice();
            return;
        }

        if (this._wsPingTimer) {
            GLib.source_remove(this._wsPingTimer);
            this._wsPingTimer = null;
        }

        this._wsConnection = null;
        this._isConnected = false;
        this._isConnecting = false;
        if (this._topBarRef) this._topBarRef.updateVisibility(false);
        this.subtitle = 'Disconnected';

        this._startReconnectCountdown(this._wsIp || Settings.loadSettings().phoneIp);
        // this._scheduleWebSocketReconnect();
    }

    _clearReconnectTimer() {
        if (this._reconnectTimerId) {
            if (typeof this._reconnectTimerId === 'number' && this._reconnectTimerId > 0) {
                GLib.source_remove(this._reconnectTimerId);
            }
            this._reconnectTimerId = null;
        }
        this._reconnectCountdown = 10;
    }

    _startReconnectCountdown(ip) {
        if (!this.checked || !ip) return;

        // If already in a countdown for the same IP, don't reset unless it's a forced call
        if (this._reconnectTimerId && this._reconnectIp === ip) return;

        this._clearReconnectTimer();
        this._reconnectIp = ip;
        this._reconnectCountdown = 10;

        console.log(`Phone HUB: Starting reconnection countdown for ${ip}`);

        // Use a placeholder to prevent recursive _startReconnectCountdown calls
        // from inside _fetchFullStateAndRebuildMenu
        this._reconnectTimerId = -1;

        // Initial rebuild to show the first countdown number
        this._fetchFullStateAndRebuildMenu(ip);

        this._reconnectTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._reconnectCountdown--;

            if (this._reconnectCountdown <= 0) {
                this._reconnectTimerId = null;
                console.log(`Phone HUB: Countdown reached 0, auto-reconnecting to ${ip}`);
                this.refreshDevices(true);
                return GLib.SOURCE_REMOVE;
            }

            // Update UI with new countdown value
            this._fetchFullStateAndRebuildMenu(ip);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scheduleWebSocketReconnect() {
        if (!this.checked || !this._wsIp) return;
        if (this._wsReconnectTimer) return;

        console.log(`Phone HUB: Scheduling WebSocket reconnect in 5s...`);
        this._wsReconnectTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._wsReconnectTimer = null;
            if (this.checked && this._wsIp) {
                this._connectWebSocket(this._wsIp);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onWebSocketMessage(type, message) {
        if (type !== Soup.WebsocketDataType.TEXT) return;
        try {
            const text = new TextDecoder().decode(message.toArray());
            const data = JSON.parse(text);

            if (this._wsPingTimer) {
                GLib.source_remove(this._wsPingTimer);
            }
            this._wsPingTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                console.log("Phone HUB: WebSocket ping timeout, closing connection");
                if (this._wsConnection) {
                    this._wsConnection.close(Soup.WebsocketCloseCode.ABNORMAL, "Ping timeout");
                }
                this._onWebSocketClosed();
                return GLib.SOURCE_REMOVE;
            });

            if (data.type === "PING") {
                if (this._wsConnection) {
                    this._wsConnection.send_text("{\"type\":\"PONG\"}");
                }
            } else if (data.type === "CALL_STATUS") {
                console.log(`Phone HUB: Received CALL_STATUS event: ${data.status} for number: ${data.number}`);
                this._handleCallEvent(data.status, data.number);
            } else if (data.type === "NOTIFICATION") {
                this._handleNotificationEvent(data);
            } else if (data.type === "CLEAR_ALL") {
                this._notifiedIds.clear();
            } else if (data.type === "UNPAIR") {
                console.log("Phone HUB: Received UNPAIR message from phone.");
                this._forgetDevice();
            }
        } catch (e) {
            console.error(`WebSocket Parse Error: ${e.message}`);
        }
    }

    _handleCallEvent(status, number) {
        const s = Settings.loadSettings();
        if (s.enableCallNotifications === false) return;

        if ((status === "RINGING" || status === "OFFHOOK") && this._lastCallStatus !== "RINGING" && this._lastCallStatus !== "OFFHOOK") {
            const extPath = Main.extensionManager.lookup('phone-hub@oualidkhial').path;
            const scriptPath = `${extPath}/callWindow.js`;
            const ip = this._wsIp;

            let argv = ['gjs', '-m', scriptPath, '--host', ip, '--number', number || 'Unknown Caller', '--status', status.toLowerCase()];
            if (s.restToken) {
                argv.push('--token', s.restToken);
            }

            try {
                // Clear any existing call window
                if (this._currentCallProc) {
                    this._closeCurrentCallWindow();
                }

                let proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDIN_PIPE
                );
                this._currentCallProc = proc;
                this._currentCallStdin = new Gio.DataOutputStream({
                    base_stream: proc.get_stdin_pipe(),
                    close_base_stream: true
                });

                // Clean up references when process exits
                proc.wait_async(null, (p, res) => {
                    try {
                        p.wait_finish(res);
                        if (this._currentCallProc === p) {
                            this._currentCallProc = null;
                            this._currentCallStdin = null;
                        }
                    } catch (e) { }
                });

                // Position window to bottom-right
                let attempts = 0;
                const positionWindow = () => {
                    attempts++;
                    if (!this._currentCallProc || attempts > 30) return GLib.SOURCE_REMOVE;

                    for (let actor of global.get_window_actors()) {
                        let metaWindow = actor.get_meta_window();
                        if (metaWindow && (metaWindow.get_title() === "Incoming Call" || metaWindow.get_title() === "Ongoing Call")) {
                            let workArea = metaWindow.get_work_area_current_monitor();
                            let frameRect = metaWindow.get_frame_rect();
                            // Only move if we got a valid size
                            if (frameRect.width > 0 && frameRect.height > 0) {
                                let padding = 32;
                                let newX = workArea.x + workArea.width - frameRect.width - padding;
                                let newY = workArea.y + workArea.height - frameRect.height - padding;
                                metaWindow.move_frame(true, newX, newY);
                                metaWindow.make_above();
                                return GLib.SOURCE_REMOVE;
                            }
                        }
                    }
                    return GLib.SOURCE_CONTINUE;
                };
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, positionWindow);

            } catch (e) {
                console.error(`Phone HUB: Failed to launch call window: ${e.message}`);
            }

        } else if ((status === "RINGING" || status === "OFFHOOK") && this._currentCallStdin) {
            // Update name/number if it arrived late from NotificationService
            if (number && number !== "Unknown Caller") {
                try {
                    this._currentCallStdin.put_string(`UPDATE:${number}\n`, null);
                    this._currentCallStdin.flush(null);
                } catch (e) {
                    console.error(`Phone HUB: Failed to send update to call window: ${e.message}`);
                }
            }
        } else if (status !== "RINGING" && status !== "OFFHOOK") {
            // Did this go from RINGING to IDLE? Or OFFHOOK to IDLE?
            if (this._lastCallStatus === "RINGING") {
                this._closeCurrentCallWindowDelayed("Missed/Declined");
            } else if (this._lastCallStatus === "OFFHOOK") {
                this._closeCurrentCallWindowDelayed("Call Ended");
            } else {
                this._closeCurrentCallWindow();
            }
        }
        this._lastCallStatus = status;
    }

    _closeCurrentCallWindowDelayed(message) {
        if (this._currentCallStdin) {
            try {
                this._currentCallStdin.put_string(`CLOSE_DELAYED:${message}\n`, null);
                this._currentCallStdin.flush(null);
            } catch (e) {
                console.error(`Phone HUB: Failed to send delayed close signal to call window: ${e.message}`);
                if (this._currentCallProc) this._currentCallProc.force_exit();
            }
            // Dereference so toggle.js doesn't try to reuse a dying window
            this._currentCallStdin = null;
            this._currentCallProc = null;
        } else {
            this._closeCurrentCallWindow();
        }
    }

    _closeCurrentCallWindow() {
        if (this._currentCallStdin) {
            try {
                this._currentCallStdin.put_string("CLOSE\n", null);
                this._currentCallStdin.flush(null);
                this._currentCallStdin.close(null);
            } catch (e) {
                console.error(`Phone HUB: Failed to send close signal to call window: ${e.message}`);
                // Fallback to force exit if stdin fails
                if (this._currentCallProc) this._currentCallProc.force_exit();
            }
            this._currentCallStdin = null;
            this._currentCallProc = null;
        } else if (this._currentCallProc) {
            this._currentCallProc.force_exit();
            this._currentCallProc = null;
        }
    }

    _sendCallAction(ip, action) {
        if (!ip) return;
        const s = Settings.loadSettings();
        const url = `http://${ip}:8080/${action}${s.restToken ? `?token=${s.restToken}` : ''}`;
        const msg = Soup.Message.new('POST', url);
        const session = new Soup.Session();
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try {
                session.send_and_read_finish(result);
                console.log(`Phone HUB: Call action '${action}' sent successfully.`);
            } catch (e) {
                console.error(`Phone HUB: Failed to send call action '${action}': ${e.message}`);
            }
        });
    }

    _handleNotificationEvent(notif) {
        const s = Settings.loadSettings();
        if (s.enablePhoneNotifications === false) return;

        if (notif.category === "call") {
            if (this._currentCallStdin) {
                try {
                    this._currentCallStdin.put_string(`STATUS:${notif.text}\n`, null);
                    this._currentCallStdin.flush(null);
                } catch (e) { }
            }
            return; // Do not show generic MessageTray notifications for call states
        }

        if (!this._notifiedIds.has(notif.id)) {
            this._notifiedIds.add(notif.id);
            this._showPhoneNotification(this._wsIp, notif);
        }
    }

    _showPhoneNotification(ip, notif) {
        if (!this._phoneNotificationSource) {
            this._phoneNotificationSource = new MessageTray.Source({
                title: 'Phone HUB',
                iconName: 'smartphone-symbolic'
            });
            this._phoneNotificationSource.connect('destroy', () => { this._phoneNotificationSource = null; });
            Main.messageTray.add(this._phoneNotificationSource);
        }

        const msg = new MessageTray.Notification({
            source: this._phoneNotificationSource,
            title: notif.title || notif.packageName,
            body: notif.text || '',
            urgency: MessageTray.Urgency.NORMAL,
        });

        msg.addAction('Clear on Phone', () => {
            this._dismissPhoneNotification(ip, notif.id);
        });

        this._phoneNotificationSource.addNotification(msg);
    }

    _dismissPhoneNotification(ip, id) {
        try {
            const s = Settings.loadSettings();
            const url = `http://${ip}:8080/notifications/clear${s.restToken ? `?token=${s.restToken}` : ''}`;
            const message = Soup.Message.new('POST', url);
            message.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify({ id: id })))
            );
            SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, () => { });
        } catch (e) { }
    }

    getPermanentMenu() {
        /* ---------- Actions Row (Pair & Settings) ---------- */
        let actionsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });

        let actionsBox = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 12px; margin: 0 12px;'
        });

        let boxPair = new St.BoxLayout({
            style: 'spacing: 6px;',
        });

        boxPair.add_child(new St.Icon({
            icon_name: 'list-add-symbolic',
            style_class: 'popup-menu-icon',
        }));

        boxPair.add_child(new St.Label({
            text: 'New Device',
            y_align: Clutter.ActorAlign.CENTER
        }));

        let pairBtn = new St.Button({
            child: boxPair,
            style_class: 'button phone-hub-btn',
            x_expand: true,
            can_focus: true
        });
        pairBtn.connect('clicked', () => {
            this.menu.close();
            const dialog = new PairingDialog((newIp, restToken, wsToken) => {
                Settings.saveSettings({
                    phoneIp: newIp,
                    restToken: restToken,
                    wsToken: wsToken
                });
                this.refreshDevices(true);
            });
            dialog.open();
        });

        let box = new St.BoxLayout();

        box.add_child(new St.Icon({
            icon_name: 'folder-open-symbolic',
            style_class: 'popup-menu-icon',
            style: 'margin-right: 6px;',
        }));

        box.add_child(new St.Label({
            text: 'Settings'
        }));

        let settingsBtn = new St.Button({
            child: box,
            style_class: 'button phone-hub-btn',
            can_focus: true,
        });
        settingsBtn.connect('clicked', () => {
            this.menu.close();
            const uri = `file://${Settings.SETTINGS_DIR}`;
            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (e) {
                console.error(`Failed to open settings folder: ${e.message}`);
                Main.notify("Phone HUB", "Failed to open settings folder.");
            }
        });

        actionsBox.add_child(pairBtn);
        actionsBox.add_child(settingsBtn);
        actionsItem.add_child(actionsBox);
        return actionsItem;
    }

    async _fetchFullStateAndRebuildMenu(pairedIp) {
        if (!pairedIp) return;
        const settings = Settings.loadSettings();

        // Optimization: If we're in a countdown, we already know the device is offline.
        // Skip metadata and ADB checks to keep the countdown smooth.
        if (this._reconnectTimerId) {
            this._isConnected = false;
            this._deviceSection.removeAll();
            if (this._topBarRef) this._topBarRef.updateVisibility(false);

            let pairedIpForOffline = settings.phoneIp;
            if (pairedIpForOffline) {
                const deviceName = this._lastKnownDeviceName || 'Paired Phone';

                // Device Header row with Forget button
                let headerItem = new PopupMenu.PopupMenuItem(deviceName);
                headerItem.sensitive = false;
                headerItem.label.style = 'font-weight: bold; opacity: 1.0;';
                headerItem.insert_child_at_index(new St.Icon({
                    icon_name: 'phone-symbolic',
                    style_class: 'popup-menu-icon'
                }), 0);

                let headerBox = headerItem.get_child_at_index(headerItem.get_n_children() - 1);
                headerItem.add_child(new St.Widget({ x_expand: true }));
                let forgetBtn = new St.Button({
                    child: new St.Icon({ icon_name: 'user-trash-symbolic', style_class: 'popup-menu-icon' }),
                    can_focus: true,
                    style_class: 'button',
                    x_align: Clutter.ActorAlign.END,
                });
                forgetBtn.connect('clicked', () => {
                    this._forgetDevice();
                    return Clutter.EVENT_STOP;
                });
                headerItem.add_child(forgetBtn);
                this._deviceSection.addMenuItem(headerItem);

                // Manual/Auto Connect Button with Countdown
                const connectLabel = `Reconnecting in ${this._reconnectCountdown}...`;
                let connectItem = new PopupMenu.PopupMenuItem(connectLabel);
                connectItem.insert_child_at_index(new St.Icon({
                    icon_name: 'view-refresh-symbolic',
                    style_class: 'popup-menu-icon'
                }), 0);

                connectItem.connect('activate', () => {
                    this._clearReconnectTimer();
                    this.subtitle = 'Connecting...';
                    this.refreshDevices(true);
                });
                this._deviceSection.addMenuItem(connectItem);

                const statusLabel = this._isConnecting ? 'Connecting...' : 'Offline';
                let offlineItem = new PopupMenu.PopupMenuItem(statusLabel);
                offlineItem.insert_child_at_index(new St.Icon({
                    icon_name: 'network-offline-symbolic',
                    style_class: 'popup-menu-icon'
                }), 0);
                offlineItem.sensitive = false;
                this._deviceSection.addMenuItem(offlineItem);

                this._deviceSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }
            return true;
        }

        // 1. Ping the paired IP specifically
        console.log(`Phone HUB: Fetching full state for IP: ${pairedIp}`);
        let metadata = await this._getDeviceMetadata(pairedIp);

        // 2. Check ADB ONLY to see if the paired device is connected via USB
        let adbMatch = null;
        let adbBattery = null;
        const adbDevices = await Adb.getDevices();
        console.log(`Phone HUB: Found ${adbDevices.length} ADB devices`);

        for (const deviceId of adbDevices) {
            const deviceIps = await Adb.getDeviceIps(deviceId);
            console.log(`Phone HUB: ADB Device ${deviceId} has IPs: ${deviceIps.join(', ')}`);

            // Match against ANY of the phone's IPs
            const isMatch = deviceIps.some(ip => ip.trim() === pairedIp.trim());

            if (isMatch) {
                console.log(`Phone HUB: Found matching ADB device: ${deviceId}`);
                adbMatch = deviceId;
                adbBattery = await Adb.getBattery(deviceId);
                break;
            }
        }

        if (!metadata) {
            this._isConnected = false;
            this.subtitle = 'Disconnected';
            this._startReconnectCountdown(pairedIp);
            return true;
        }

        const isPaired = metadata?.authorized === true;
        this._isConnected = true;
        if (metadata?.name) {
            this._lastKnownDeviceName = metadata.name;
            this.subtitle = metadata.name;
            // Persist so it survives extension restarts
            const s = Settings.loadSettings();
            s.deviceName = metadata.name;
            Settings.saveSettings(s);
        }

        this._updateMenu([{
            id: adbMatch || pairedIp,
            ip: pairedIp,
            name: metadata?.name || "Paired Phone",
            isAdb: !!adbMatch,
            isNetwork: true,
            isPaired: isPaired,
            battery: adbBattery
        }]);
    }

    async _getDeviceMetadata(ip) {
        return new Promise((resolve) => {
            try {
                const s = Settings.loadSettings();
                const url = s.restToken ? `http://${ip}:8080/?token=${s.restToken}` : `http://${ip}:8080/`;
                const message = Soup.Message.new('GET', url);
                const cancellable = new Gio.Cancellable();

                // Hard abort after 5 seconds
                const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                    cancellable.cancel();
                    resolve(null);
                    return GLib.SOURCE_REMOVE;
                });

                SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                    GLib.source_remove(timerId);
                    try {
                        const bytes = session.send_and_read_finish(res);
                        if (message.status_code === 200) {
                            const data = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                            resolve({
                                name: data.deviceName || "Phone",
                                authorized: data.authorized,
                                callStatus: data.callStatus,
                                callerNumber: data.callerNumber
                            });
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            } catch (e) {
                resolve(null);
            }
        });
    }

    /* ===============================
       Build Menu
    =================================*/
    async _updateMenu(visibleDevices) {
        this._deviceSection.removeAll();
        // const hasAdb = await Adb.checkAdb();



        if (visibleDevices.length === 0) {
            let infoItem = new PopupMenu.PopupMenuItem('No paired devices');
            infoItem.sensitive = false;
            let permanentMenu = this.getPermanentMenu();
            this._deviceSection.addMenuItem(permanentMenu);
            this.subtitle = 'Disconnected';
            if (this._topBarRef) this._topBarRef.updateVisibility(false);
        } else {
            visibleDevices.forEach(dev => {
                let connectionLabel = dev.isAdb ? `${dev.name} (ADB + Network)` : `${dev.name} (Network)`;
                this._addDeviceToMenu(dev.id, connectionLabel, !dev.isAdb, dev.isPaired);
                if (this._topBarRef) {
                    this._topBarRef.updateVisibility(true);
                    this._topBarRef.rebuildMenu(dev.id, dev.name, dev.isPaired, !dev.isAdb);
                }
            });
            this.subtitle = visibleDevices[0].isPaired ? this._lastKnownDeviceName : 'Action Required';
        }
    }


    getMountToogle(isPaired, isNetwork, deviceId) {
        /* ---------- SSHFS Mount ---------- */
        const sshfsSettings = Settings.loadSettings();
        const mountPoint = sshfsSettings.sshfsMountPoint;
        this._mountToggle = new PopupMenu.PopupSwitchMenuItem('Mount Files', Mount.isMounted(mountPoint));
        let mountToggle = this._mountToggle;
        mountToggle.insert_child_at_index(new St.Icon({
            icon_name: 'folder-remote-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);

        if (!isPaired || !Mount.checkSshfs()) {
            mountToggle.sensitive = false;
            if (!isPaired) mountToggle.label.text += ' (Not Paired)';
            else mountToggle.label.text += ' (sshfs missing)';
        }

        mountToggle.connect('toggled', async (item, state) => {
            if (state) {
                try {
                    const s = Settings.loadSettings();
                    let ip = s.phoneIp || (isNetwork ? deviceId : null);
                    if (!ip && !isNetwork) {
                        const ips = await Adb.getDeviceIps(deviceId);
                        ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                    }
                    if (!ip) throw new Error("Could not find device IP");

                    await Mount.mountDevice(ip, s);
                    Main.notify("Phone HUB", "Phone files mounted at " + mountPoint);
                    if (this._topBarRef) this._topBarRef.syncMountState(true);
                } catch (e) {
                    Main.notify("Phone HUB", "Failed to mount: " + e.message);
                    mountToggle.setToggleState(false);
                }
            } else {
                try {
                    await Mount.unmountDevice(mountPoint);
                    Main.notify("Phone HUB", "Phone files unmounted");
                    if (this._topBarRef) this._topBarRef.syncMountState(false);
                } catch (e) {
                    Main.notify("Phone HUB", "Failed to unmount: " + e.message);
                    mountToggle.setToggleState(true);
                }
            }
        });

        return mountToggle;
    }


    getCameraToggle(isPaired, isNetwork, deviceId, hasScrcpy) {
        let cameraToggle = new PopupMenu.PopupSwitchMenuItem('Use as webcam', false);
        cameraToggle.insert_child_at_index(new St.Icon({
            icon_name: 'camera-video-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);

        if (!hasScrcpy || isNetwork || !isPaired) {
            cameraToggle.sensitive = false;
            if (!isPaired) cameraToggle.label.text += ' (Not Paired)';
            else if (!hasScrcpy) cameraToggle.label.text += ' (scrcpy missing)';
            else if (isNetwork) cameraToggle.label.text += ' (USB only)';
        }

        cameraToggle.connect('toggled', (item, state) => {
            if (state) {
                Scrcpy.startCamera(deviceId, this._getDeviceProcesses(deviceId));
            } else {
                this._stopCamera(deviceId);
            }
        });

        return cameraToggle;
    }

    getMirrorToggle(isPaired, isNetwork, deviceId, hasScrcpy) {
        let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror Display', false);
        mirrorToggle.insert_child_at_index(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);

        if (!hasScrcpy || isNetwork || !isPaired) {
            mirrorToggle.sensitive = false;
            if (!isPaired) mirrorToggle.label.text += ' (Not Paired)';
            else if (!hasScrcpy) mirrorToggle.label.text += ' (scrcpy missing)';
            else if (isNetwork) mirrorToggle.label.text += ' (USB only)';
        }

        mirrorToggle.connect('toggled', (item, state) => {
            if (state) {
                Scrcpy.startMirroring(deviceId, this._getDeviceProcesses(deviceId));
            } else {
                this._stopMirror(deviceId);
            }
        });

        return mirrorToggle;
    }

    getCallNotifToggle() {
        const callNotifSettings = Settings.loadSettings();

        let callNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Call Notifications',
            callNotifSettings.enableCallNotifications !== false
        );
        callNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'call-incoming-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        callNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enableCallNotifications = state;
            Settings.saveSettings(s);
        });
        return callNotifToggle;
    }

    getPhoneNotificationsToggle() {
        const callNotifSettings = Settings.loadSettings();

        let phoneNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Sync Notifications',
            callNotifSettings.enablePhoneNotifications !== false
        );
        phoneNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'mail-unread-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        phoneNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enablePhoneNotifications = state;
            Settings.saveSettings(s);
            if (!state) {
                this._notifiedIds.clear();
            }
        });
        return phoneNotifToggle;
    }

    getFindMyPhoneItem(isPaired, deviceId, isNetwork) {
        let findPhoneItem = new PopupMenu.PopupMenuItem('Find My Phone');
        const icon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            style_class: 'popup-menu-icon',
        });
        findPhoneItem.insert_child_at_index(icon, 0);

        if (!isPaired) {
            findPhoneItem.sensitive = false;
        }

        let isRinging = false;
        findPhoneItem.connect('activate', async () => {
            let ip = isNetwork ? deviceId : null;
            if (!isNetwork) {
                const s = Settings.loadSettings();
                ip = s.phoneIp;
                if (!ip) {
                    const ips = await Adb.getDeviceIps(deviceId);
                    ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                }
            }

            if (!ip) return;

            const s = Settings.loadSettings();
            const token = s.restToken;
            const action = isRinging ? 'stop' : 'start';

            try {
                const message = Soup.Message.new('POST', `http://${ip}:8080/ring?token=${token}&action=${action}`);
                SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        // No need to parse if we just care about success
                        isRinging = !isRinging;
                        if (isRinging) {
                            findPhoneItem.label.text = 'Stop Ringing Phone';
                            icon.icon_name = 'audio-volume-muted-symbolic';
                        } else {
                            findPhoneItem.label.text = 'Find My Phone';
                            icon.icon_name = 'audio-volume-high-symbolic';
                        }
                    } catch (e) {
                        console.error(`Find My Phone Error: ${e.message}`);
                    }
                });
            } catch (e) {
                console.error(`Find My Phone Error: ${e.message}`);
            }
        });

        return findPhoneItem;
    }


    getDeviceheaderMenu(label, isPaired) {

        // Main Header Container (Vertical)
        let headerBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            style: 'padding-top: 0px; padding-bottom: 0px;'
        });

        // Row 1: Device Name
        let nameRow = new St.BoxLayout({ vertical: false });
        nameRow.add_child(new St.Icon({
            icon_name: 'phone-symbolic',
            style_class: 'popup-menu-icon'
        }));
        let nameLabel = new St.Label({
            text: label,
            style: 'font-weight: bold; opacity: 1.0; margin-left: 10px;',
            y_align: Clutter.ActorAlign.CENTER
        });
        nameRow.add_child(nameLabel);
        headerBox.add_child(nameRow);

        // Row 2: Status & Icons
        let statusRow = new St.BoxLayout({
            vertical: false,
            style: 'margin-top: 4px; margin-left: 0px;'
        });

        this._operatorLabel = new St.Label({
            text: isPaired ? 'Mobile Network' : '',
            style: 'font-size: 1em; font-weight: bold; opacity: 1; color: white',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        statusRow.add_child(this._operatorLabel);

        // Status Icons Box (Right)
        let iconsBox = new St.BoxLayout({
            vertical: false,
            style_class: 'battery-container',
            visible: isPaired
        });

        this._networkTypeLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.8em; margin-right: 8px; font-weight: bold; opacity: 1; color: white'
        });
        iconsBox.add_child(this._networkTypeLabel);

        this._bluetoothIcon = new St.Icon({
            icon_name: 'bluetooth-active-symbolic', // Will change to bluetooth-disabled-symbolic if off
            style_class: 'popup-menu-icon',
            opacity: 120,

            style: "color: white; font-size: 0.80em;   margin-right: 8px;"
        });
        iconsBox.add_child(this._bluetoothIcon);

        this._dataIcon = new St.Icon({
            icon_name: 'network-cellular-offline-symbolic',
            style_class: 'popup-menu-icon',
            style: 'font-size: 0.8em; margin-right: 8px; font-weight: bold; opacity: 1; color: white',

        });
        iconsBox.add_child(this._dataIcon);

        this._batteryLabel = new St.Label({
            text: '--%',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 0.85em; margin-right: 4px; opacity: 0.8; color: white;'
        });
        iconsBox.add_child(this._batteryLabel);

        this._batteryIcon = new St.Icon({
            icon_name: 'battery-missing-symbolic',
            style_class: 'popup-menu-icon',
            opacity: 180
        });
        // iconsBox.add_child(this._batteryIcon);

        statusRow.add_child(iconsBox);
        headerBox.add_child(statusRow);

        let headerItem = new PopupMenu.PopupMenuItem('');
        headerItem.add_child(headerBox);
        headerItem.sensitive = false;
        return headerItem;

    }


    async _addDeviceToMenu(deviceId, label, isNetwork, isPaired = false) {

        try {
            /* ---------- Ask for re pair for known unpaired devices ---------- */
            if (!isPaired) {
                let pairItem = new PopupMenu.PopupMenuItem('Pair Device (Accept on Phone)');
                pairItem.insert_child_at_index(new St.Icon({
                    icon_name: 'network-transmit-receive-symbolic',
                    style_class: 'popup-menu-icon',
                }), 0);

                pairItem.connect('activate', async () => {
                    let ip = isNetwork ? deviceId : null;
                    if (!isNetwork) {
                        const ips = await Adb.getDeviceIps(deviceId);
                        ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
                    }

                    if (!ip) {
                        Main.notify("Phone HUB", "Could not find device IP.");
                        return;
                    }

                    Main.notify("Phone HUB", "Pairing request sent. Please check your phone.");

                    try {
                        const hostname = GLib.get_host_name();
                        const message = Soup.Message.new('POST', `http://${ip}:8080/pair?deviceName=${encodeURIComponent(hostname)}`);
                        SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                            try {
                                session.send_and_read_finish(res);
                            } catch (e) {
                                console.error(`Pairing Error: ${e.message}`);
                            }
                        });
                    } catch (e) {
                        console.error(`Pairing Error: ${e.message}`);
                    }
                });
                this._deviceSection.addMenuItem(pairItem);
            }


            if (isPaired) {
                this._startStatusPolling(deviceId, isNetwork);
                const hasScrcpy = Scrcpy.checkScrcpy();
                /* ---------- header ---------- */

                let headerItem = this.getDeviceheaderMenu(label, isPaired);
                this._deviceSection.addMenuItem(headerItem);


                this._deviceSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());


                /* ---------- Mount ---------- */

                let mountToggle = this.getMountToogle(isPaired, isNetwork, deviceId);

                this._deviceSection.addMenuItem(mountToggle);


                /* ---------- Call Notifications ---------- */

                let callNotifToggle = this.getCallNotifToggle();
                this._deviceSection.addMenuItem(callNotifToggle);

                /* ---------- Phone Notifications ---------- */
                let phoneNotifToggle = this.getPhoneNotificationsToggle();
                this._deviceSection.addMenuItem(phoneNotifToggle);

                /* ---------- Find My Phone ---------- */
                let findPhoneItem = this.getFindMyPhoneItem(isPaired, deviceId, isNetwork);
                this._deviceSection.addMenuItem(findPhoneItem);



                this._deviceSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                /* ---------- Camera ---------- */
                let cameraToggle = this.getCameraToggle(isPaired, isNetwork, deviceId, hasScrcpy);
                this._deviceSection.addMenuItem(cameraToggle);

                /* ---------- Mirror ---------- */
                let mirrorToggle = this.getMirrorToggle(isPaired, isNetwork, deviceId, hasScrcpy);
                this._deviceSection.addMenuItem(mirrorToggle);



                this._deviceSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());




                /* ---------- Forget Device ---------- */
                let forgetItem = new PopupMenu.PopupMenuItem('Forget Device');
                forgetItem.insert_child_at_index(new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style_class: 'popup-menu-icon',
                }), 0);
                forgetItem.style = 'color: #ed333b;'; // Soft red
                forgetItem.connect('activate', () => {
                    this._forgetDevice();
                });
                this._deviceSection.addMenuItem(forgetItem);

            }
        } catch (e) {
            console.log(e)
        }
    }

    _forgetDevice() {
        this._stopStatusPolling();
        const settings = Settings.loadSettings();
        const ip = settings.phoneIp;

        if (ip && this._isConnected) {
            try {
                const message = Soup.Message.new('POST', `http://${ip}:8080/unpair`);
                SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, () => { });
            } catch (e) {
                console.error(`Failed to notify phone of unpair: ${e.message}`);
            }
        }

        const s = Settings.loadSettings();
        if (s.sshfsMountPoint && Mount.isMounted(s.sshfsMountPoint)) {
            Mount.unmountDevice(s.sshfsMountPoint).catch(e => console.error(e));
        }

        Settings.saveSettings({ phoneIp: "", deviceName: "" });
        this._disconnectWebSocket();
        if (this._topBarRef) this._topBarRef.updateVisibility(false);
        this.refreshDevices(true);
        Main.notify("Phone HUB", "Device removed.");
    }

    /* ===============================
       Device Status Polling (Battery & Data)
    =================================*/
    async _startStatusPolling(deviceId, isNetwork) {
        this._stopStatusPolling();

        const s = Settings.loadSettings();
        let ip = isNetwork ? deviceId : s.phoneIp;

        if (!ip && !isNetwork) {
            const ips = await Adb.getDeviceIps(deviceId);
            ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
        }

        if (!ip) return;
        this._lastDataIP = ip;

        this._fetchBatteryLevel(ip);
        this._fetchDataStatus(ip);
        this._fetchBluetoothStatus(ip);

        this._statusPollingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this._fetchBatteryLevel(ip);
            this._fetchDataStatus(ip);
            this._fetchBluetoothStatus(ip);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopStatusPolling() {
        if (this._statusPollingId) {
            GLib.source_remove(this._statusPollingId);
            this._statusPollingId = null;
        }
    }

    async _fetchBatteryLevel(ip) {
        const s = Settings.loadSettings();
        const password = s.restToken;
        if (!password) return;

        const argv = [
            'sshpass', '-p', password,
            'ssh', '-p', '2222',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=5',
            `phonehub@${ip}`,
            'battery'
        ];

        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [ok, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (ok && stdout) {
                        // Expected output: "Battery Level: 85%"
                        const match = stdout.match(/Battery Level: (\d+)%/);
                        if (match && match[1]) {
                            this._updateBatteryUI(parseInt(match[1]));
                        }
                    }
                } catch (e) {
                    console.error(`Battery fetch failed: ${e.message}`);
                }
            });
        } catch (e) {
            console.error(`Battery exec failed: ${e.message}`);
        }
    }

    async _fetchDataStatus(ip) {
        const s = Settings.loadSettings();
        const password = s.restToken;
        if (!password) return;

        const argv = [
            'sshpass', '-p', password,
            'ssh', '-p', '2222',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=5',
            `phonehub@${ip}`,
            'mobile_data status'
        ];

        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [ok, stdout] = p.communicate_utf8_finish(res);
                    if (ok && stdout) {
                        const status = stdout.includes(': on') ? 'on' : 'off';
                        let operator = '';
                        let networkType = '';
                        if (stdout.includes('(')) {
                            const content = stdout.substring(stdout.indexOf('(') + 1, stdout.indexOf(')')).trim();
                            if (content.includes(' - ')) {
                                [operator, networkType] = content.split(' - ').map(s => s.trim());
                            } else {
                                operator = content;
                            }
                        }
                        this._updateDataUI(status, operator, networkType);
                    }
                } catch (e) { }
            });
        } catch (e) { }
    }

    async _fetchBluetoothStatus(ip) {
        const s = Settings.loadSettings();
        const password = s.restToken;
        if (!password) return;

        const argv = [
            'sshpass', '-p', password,
            'ssh', '-p', '2222',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=5',
            `phonehub@${ip}`,
            'bluetooth'
        ];

        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [ok, stdout] = p.communicate_utf8_finish(res);
                    if (ok && stdout) {
                        const status = stdout.includes(': on') ? 'on' : 'off';
                        this._updateBluetoothUI(status);
                    }
                } catch (e) { }
            });
        } catch (e) { }
    }

    _updateDataUI(status, operator, networkType) {
        this._lastDataStatus = status;
        const iconName = status === 'on'
            ? 'network-transmit-receive-symbolic'
            : 'network-cellular-offline-symbolic';

        if (this._dataIcon) {
            this._dataIcon.icon_name = iconName;
            this._dataIcon.opacity = status === 'on' ? 255 : 120;
        }

        if (this._operatorLabel) {
            this._operatorLabel.text = operator || (status === 'on' ? 'Mobile Network' : 'Disconnected');
        }

        if (this._networkTypeLabel) {
            this._networkTypeLabel.text = networkType;
        }

        if (this._topBarRef && this._topBarRef.updateDataStatus) {
            this._topBarRef.updateDataStatus(status, iconName, operator, networkType);
        }
    }

    _updateBluetoothUI(status) {
        // status is 'on' or 'off'
        const iconName = status === 'on'
            ? 'bluetooth-active-symbolic'
            : 'bluetooth-disabled-symbolic';

        if (this._bluetoothIcon) {
            this._bluetoothIcon.icon_name = iconName;
            this._bluetoothIcon.opacity = status === 'on' ? 255 : 120;
        }

        if (this._topBarRef && this._topBarRef.updateBluetoothStatus) {
            this._topBarRef.updateBluetoothStatus(status);
        }
    }

    _updateBatteryUI(level) {
        this._lastBatteryLevel = level;
        if (this._batteryLabel) this._batteryLabel.text = `${level}%`;
        if (this._batteryIcon) {
            this._batteryIcon.icon_name = this._getBatteryIcon(level);
        }
        if (this._topBarRef && this._topBarRef.updateBattery) {
            this._topBarRef.updateBattery(level, this._getBatteryIcon(level));
        }
    }

    _getBatteryIcon(level) {
        if (level === null) return 'battery-missing-symbolic';
        if (level >= 90) return 'battery-full-symbolic';
        if (level >= 60) return 'battery-good-symbolic';
        if (level >= 20) return 'battery-low-symbolic';
        return 'battery-caution-symbolic';
    }

    /* ===============================
       Process helpers
    =================================*/
    _getDeviceProcesses(deviceId) {
        if (!this._activeProcesses.has(deviceId)) {
            this._activeProcesses.set(deviceId, {
                camera: null,
                mirror: null,
                notifications: null,
                app: null
            });
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
            if (procs.app) procs.app.force_exit();
        }
        this._activeProcesses.clear();

        const s = Settings.loadSettings();
        if (s.sshfsMountPoint && Mount.isMounted(s.sshfsMountPoint)) {
            Mount.unmountDevice(s.sshfsMountPoint).catch(e => console.error(e));
        }

        this._scanning = true;
    }

    syncMountState(state) {
        if (this._mountToggle && this._mountToggle.state !== state) {
            this._mountToggle.setToggleState(state);
        }
    }
});

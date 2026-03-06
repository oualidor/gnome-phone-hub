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
        this._scanning = false;

        // Map<deviceId, {camera: Gio.Subprocess|null, mirror: Gio.Subprocess|null, notifications: Gio.Subprocess|null}>
        this._activeProcesses = new Map();

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
                this._notifiedIds.clear();
                this.stopAllProcesses();
                this._deviceSection.removeAll();
                if (this._topBarRef) this._topBarRef.updateVisibility(false);
                this.subtitle = 'Disabled';
                this._isConnected = false;
            }
        });
    }

    /* ===============================
       WebSocket Connection Management
    =================================*/
    _connectWebSocket(ip) {
        if (this._wsConnection) return;
        this._wsIp = ip;

        const s = Settings.loadSettings();
        const url = s.wsToken ? `ws://${ip}:8080/ws?token=${s.wsToken}` : `ws://${ip}:8080/ws`;
        const message = Soup.Message.new('GET', url);
        const cancellable = new Gio.Cancellable();

        // Hard abort after 5 seconds if phone is offline
        const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (!this._wsConnection) {
                cancellable.cancel();
            }
            return GLib.SOURCE_REMOVE;
        });

        SoupSession.websocket_connect_async(message, null, null, null, cancellable, (session, res) => {
            GLib.source_remove(timerId);
            try {
                this._wsConnection = session.websocket_connect_finish(res);
                console.log(`Phone HUB: WebSocket connected to ${ip}`);

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
                this._onWebSocketClosed();
            }
        });
    }

    _disconnectWebSocket() {
        this._wsIp = null;
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
        if (this._topBarRef) this._topBarRef.updateVisibility(false);
        this.subtitle = 'Disconnected';

        this.refreshDevices(true);
        this._scheduleWebSocketReconnect();
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
        if (status === "RINGING" && this._lastCallStatus !== "RINGING") {
            const s = Settings.loadSettings();
            if (s.enableCallNotifications === false) return;

            if (!this._notificationSource) {
                this._notificationSource = new MessageTray.Source({
                    title: 'Phone HUB',
                    iconName: 'phone-symbolic'
                });
                this._notificationSource.connect('destroy', () => { this._notificationSource = null; });
                Main.messageTray.add(this._notificationSource);
            }

            const notification = new MessageTray.Notification({
                source: this._notificationSource,
                title: "Incoming Call",
                body: number || 'Unknown Caller',
                urgency: MessageTray.Urgency.CRITICAL,
            });
            notification.addAction('Answer', () => {
                this._sendCallAction(this._wsIp, 'answer_call');
            });
            notification.addAction('Decline', () => {
                this._sendCallAction(this._wsIp, 'decline_call');
            });

            notification.connect('destroy', () => {
                if (this._currentCallNotify === notification)
                    this._currentCallNotify = null;
            });
            this._notificationSource.addNotification(notification);
            this._currentCallNotify = notification;
        } else if (status === "RINGING" && this._currentCallNotify) {
            // Update name/number if it arrived late
            if (number && (this._currentCallNotify.body === "Unknown Caller" || this._currentCallNotify.body === "")) {
                this._currentCallNotify.update(this._currentCallNotify.title, number);
            }
        } else if (status !== "RINGING") {
            if (this._currentCallNotify) {
                this._currentCallNotify.destroy();
                this._currentCallNotify = null;
            }
        }
        this._lastCallStatus = status;
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

    /* ===============================
       Refresh devices (non-blocking)
    =================================*/
    async refreshDevices(force = false) {
        if (!this._scanning && !force)
            return true;

        this._scanning = false;
        const settings = Settings.loadSettings();
        const pairedIp = settings.phoneIp;

        if (!pairedIp) {
            this._updateMenu([], null);
            return true;
        }

        if (this._wsConnection && this._wsIp !== pairedIp) {
            this._disconnectWebSocket();
        }

        if (!this._wsConnection) {
            this._connectWebSocket(pairedIp);
        } else if (force) {
            this._fetchFullStateAndRebuildMenu(pairedIp);
        }
        return true;
    }

    async _fetchFullStateAndRebuildMenu(pairedIp) {
        const settings = Settings.loadSettings();

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
            this._deviceSection.removeAll();
            if (this._topBarRef) this._topBarRef.updateVisibility(false);
            // Show the last known device as disconnected so user knows which phone is paired
            let pairedIpForOffline = settings.phoneIp;
            if (pairedIpForOffline) {
                let deviceSubMenu = new PopupMenu.PopupSubMenuMenuItem(`${this._lastKnownDeviceName}`, true);
                deviceSubMenu.iconName = 'phone-symbolic';
                let offlineItem = new PopupMenu.PopupMenuItem('Disconnected');
                offlineItem.insert_child_at_index(new St.Icon({ icon_name: 'network-offline-symbolic', style_class: 'popup-menu-icon' }), 0);
                offlineItem.sensitive = false;
                deviceSubMenu.menu.addMenuItem(offlineItem);

                deviceSubMenu.add_child(new St.Widget({ x_expand: true }));
                let forgetOfflineBtn = new St.Button({
                    child: new St.Icon({ icon_name: 'user-trash-symbolic', style_class: 'user-trash-symbolic' }),
                    can_focus: true,
                    style_class: 'button',
                    x_align: Clutter.ActorAlign.END,
                });
                forgetOfflineBtn.connect('clicked', () => {
                    this._forgetDevice();
                    return Clutter.EVENT_STOP;
                });
                deviceSubMenu.add_child(forgetOfflineBtn);

                this._deviceSection.addMenuItem(deviceSubMenu);
            }
            // Always show Pair New Device
            let pairNewItem = new PopupMenu.PopupMenuItem('Pair New Device');
            pairNewItem.add_child(new St.Widget({ x_expand: true }));
            pairNewItem.add_child(new St.Icon({ icon_name: 'network-transmit-receive-symbolic' }));
            pairNewItem.connect('activate', () => {
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
            this._deviceSection.addMenuItem(pairNewItem);
            return true;
        }

        const isPaired = metadata?.authorized === true;
        this._isConnected = true;
        if (metadata?.name) {
            this._lastKnownDeviceName = metadata.name;
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
        const hasAdb = await Adb.checkAdb();

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
        this._deviceSection.addMenuItem(actionsItem);

        if (visibleDevices.length === 0) {
            let infoItem = new PopupMenu.PopupMenuItem('No paired devices');
            infoItem.sensitive = false;
            this._deviceSection.addMenuItem(infoItem);
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
            this.subtitle = visibleDevices[0].isPaired ? 'Connected' : 'Action Required';
        }
    }

    async _addDeviceToMenu(deviceId, label, isNetwork, isPaired = false) {
        let deviceSubMenu = new PopupMenu.PopupSubMenuMenuItem(label, true);
        deviceSubMenu.iconName = 'phone-symbolic';

        deviceSubMenu.add_child(new St.Widget({ x_expand: true }));
        let unpairBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'popup-menu-icon',
            }),
            can_focus: true,
            style_class: 'button',
            x_align: Clutter.ActorAlign.END,
        });
        unpairBtn.connect('clicked', () => {
            this._forgetDevice();
            return Clutter.EVENT_STOP;
        });
        deviceSubMenu.add_child(unpairBtn);

        const hasScrcpy = Scrcpy.checkScrcpy();

        /* ---------- Pair ---------- */
        let pairLabel = isPaired ? 'Device Paired' : 'Pair Device (Accept on Phone)';
        let pairItem = new PopupMenu.PopupMenuItem(pairLabel);
        pairItem.insert_child_at_index(new St.Icon({
            icon_name: isPaired ? 'emblem-ok-symbolic' : 'network-transmit-receive-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);

        if (isPaired) {
            pairItem.sensitive = false;
        } else {
            pairItem.connect('activate', async () => {
                let ip = isNetwork ? deviceId : null;
                if (!isNetwork) {
                    const ips = await Adb.getDeviceIps(deviceId);
                    // Prioritize LAN IPs (192.168.x.x, 10.x.x.x, 172.16.x.x)
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
                            const bytes = session.send_and_read_finish(res);
                            if (message.status_code === 200) {
                                console.log("Pairing request success");
                            }
                        } catch (e) {
                            console.error(`Pairing Error: ${e.message}`);
                        }
                    });
                } catch (e) {
                    console.error(`Pairing Error: ${e.message}`);
                }
            });
        }
        deviceSubMenu.menu.addMenuItem(pairItem);

        deviceSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

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
        deviceSubMenu.menu.addMenuItem(mountToggle);

        deviceSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* ---------- Camera ---------- */
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

        /* ---------- Mirror ---------- */
        let mirrorToggle = new PopupMenu.PopupSwitchMenuItem('Mirror', false);
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

        /* ---------- SMS ---------- */
        let smsItem = new PopupMenu.PopupMenuItem('View SMS Messages');
        smsItem.insert_child_at_index(new St.Icon({
            icon_name: 'chat-message-new-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);

        if (!isPaired) {
            smsItem.sensitive = false;
            smsItem.label.text += ' (Not Paired)';
        }

        smsItem.connect('activate', async () => {
            let ip = isNetwork ? deviceId : null;
            if (!isNetwork) {
                const ips = await Adb.getDeviceIps(deviceId);
                // Prioritize LAN IPs (192.168.x.x, 10.x.x.x, 172.16.x.x)
                ip = ips.find(i => i.startsWith('192.168.') || i.startsWith('10.') || i.startsWith('172.')) || ips[0];
            }

            const extensionPath = Main.extensionManager.lookup('phone-hub@oualidkhial').path;
            const scriptPath = `${extensionPath}/smsWindow.js`;

            const s = Settings.loadSettings();
            let argv = ['gjs', '-m', scriptPath];
            if (ip) {
                argv.push('--host', ip);
            }
            if (s.restToken) {
                argv.push('--token', s.restToken);
            }

            try {
                let proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                const stdoutReader = new Gio.DataInputStream({
                    base_stream: proc.get_stdout_pipe(),
                    close_base_stream: true
                });
                const readStdout = () => {
                    stdoutReader.read_line_async(GLib.PRIORITY_LOW, null, (stream, res) => {
                        try {
                            const [line] = stream.read_line_finish_utf8(res);
                            if (line !== null) {
                                console.log(`SMS Window STDOUT: ${line}`);
                                readStdout();
                            }
                        } catch (e) { }
                    });
                };
                readStdout();

                const stderrReader = new Gio.DataInputStream({
                    base_stream: proc.get_stderr_pipe(),
                    close_base_stream: true
                });
                const readStderr = () => {
                    stderrReader.read_line_async(GLib.PRIORITY_LOW, null, (stream, res) => {
                        try {
                            const [line] = stream.read_line_finish_utf8(res);
                            if (line !== null) {
                                console.error(`SMS Window STDERR: ${line}`);
                                readStderr();
                            }
                        } catch (e) { }
                    });
                };
                readStderr();
            } catch (e) {
                console.error(`Failed to launch SMS Window: ${e.message}`);
            }
        });

        /* ---------- Call Notifications ---------- */
        const callNotifSettings = Settings.loadSettings();
        let callNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Call Notifications',
            callNotifSettings.enableCallNotifications !== false
        );
        callNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'call-incoming-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        if (!isPaired) {
            callNotifToggle.sensitive = false;
            callNotifToggle.label.text += ' (Not Paired)';
        }
        callNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enableCallNotifications = state;
            Settings.saveSettings(s);
        });

        /* ---------- Phone Notifications ---------- */
        let phoneNotifToggle = new PopupMenu.PopupSwitchMenuItem(
            'Sync Notifications',
            callNotifSettings.enablePhoneNotifications !== false
        );
        phoneNotifToggle.insert_child_at_index(new St.Icon({
            icon_name: 'mail-unread-symbolic',
            style_class: 'popup-menu-icon',
        }), 0);
        if (!isPaired) {
            phoneNotifToggle.sensitive = false;
            phoneNotifToggle.label.text += ' (Not Paired)';
        }
        phoneNotifToggle.connect('toggled', (_item, state) => {
            const s = Settings.loadSettings();
            s.enablePhoneNotifications = state;
            Settings.saveSettings(s);
            if (!state) {
                this._notifiedIds.clear();
            }
        });

        if (isPaired) {
            // deviceSubMenu.menu.addMenuItem(smsItem);
            deviceSubMenu.menu.addMenuItem(callNotifToggle);
            deviceSubMenu.menu.addMenuItem(phoneNotifToggle);
            deviceSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            deviceSubMenu.menu.addMenuItem(cameraToggle);
            deviceSubMenu.menu.addMenuItem(mirrorToggle);
        }

        this._deviceSection.addMenuItem(deviceSubMenu);
    }

    _forgetDevice() {
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
       Process helpers
    =================================*/
    _getDeviceProcesses(deviceId) {
        if (!this._activeProcesses.has(deviceId)) {
            this._activeProcesses.set(deviceId, { camera: null, mirror: null, notifications: null });
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

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

        // Connection health-check state
        this._statusPollingId = null;
        this._isConnected = false;
        const _initSettings = Settings.loadSettings();
        this._lastKnownDeviceName = _initSettings.deviceName || 'Paired Phone';



        this.connect('notify::checked', () => {
            if (this.checked) {
                this._scanning = true;
                this.subtitle = 'Connecting...';
                this.refreshDevices(true);
                this._startCallPolling();
                this._startStatusPolling();
            } else {
                this._scanning = false;
                this._stopCallPolling();
                this._stopStatusPolling();
                this.stopAllProcesses();
                this._deviceSection.removeAll();
                this.subtitle = 'Disabled';
                this._isConnected = false;
            }
        });
    }

    /* ===============================
       Connection Health-Check
    =================================*/
    _startStatusPolling() {
        this._stopStatusPolling();
        this._statusPollingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._checkConnectionStatus().catch(e => console.error(`Status check error: ${e.message}`));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopStatusPolling() {
        if (this._statusPollingId) {
            GLib.source_remove(this._statusPollingId);
            this._statusPollingId = null;
        }
    }

    async _checkConnectionStatus() {
        const settings = Settings.loadSettings();
        const ip = settings.phoneIp;
        if (!ip) return;

        const metadata = await this._getDeviceMetadata(ip);
        const nowConnected = metadata !== null;

        if (!nowConnected && this._isConnected) {
            this._isConnected = false;
            this.subtitle = 'Disconnected';
            this._deviceSection.removeAll();
            let offlineInfo = new PopupMenu.PopupMenuItem(`${this._lastKnownDeviceName} (Disconnected)`);
            offlineInfo.insert_child_at_index(new St.Icon({ icon_name: 'phone-symbolic', style_class: 'popup-menu-icon' }), 0);
            offlineInfo.sensitive = false;
            this._deviceSection.addMenuItem(offlineInfo);
            let pairNewItem = new PopupMenu.PopupMenuItem('Pair New Device');
            pairNewItem.add_child(new St.Widget({ x_expand: true }));
            pairNewItem.add_child(new St.Icon({ icon_name: 'network-transmit-receive-symbolic' }));
            pairNewItem.connect('activate', () => {
                const dialog = new PairingDialog((newIp) => {
                    Settings.saveSettings({ phoneIp: newIp });
                    this.refreshDevices(true);
                });
                dialog.open();
            });
            this._deviceSection.addMenuItem(pairNewItem);
        } else if (nowConnected && !this._isConnected) {
            this._isConnected = true;
            this.refreshDevices(true);
        }
    }

    /* ===============================
       Call Polling & Notifications
    =================================*/
    _startCallPolling() {
        const s = Settings.loadSettings();
        if (s.enableCallNotifications === false) return;
        this._stopCallPolling();
        this._callPollingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._pollCallStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCallPolling() {
        if (this._callPollingId) {
            GLib.source_remove(this._callPollingId);
            this._callPollingId = null;
        }
    }

    async _pollCallStatus() {
        try {
            const settings = Settings.loadSettings();
            const ip = settings.phoneIp;
            if (!ip) return;

            const metadata = await this._getDeviceMetadata(ip);
            if (!metadata) return;

            const status = metadata.callStatus || "IDLE";
            const number = metadata.callerNumber || "Unknown";

            if (status === "RINGING" && this._lastCallStatus !== "RINGING") {
                if (!this._notificationSource) {
                    this._notificationSource = new MessageTray.Source({
                        title: 'Phone HUB',
                        iconName: 'phone-symbolic'
                    });
                    Main.messageTray.add(this._notificationSource);
                }


                const notification = new MessageTray.Notification({
                    source: this._notificationSource,
                    title: "Incoming Call",
                    body: `Caller: ${number}`,
                    urgency: MessageTray.Urgency.CRITICAL,
                });
                notification.addAction('Answer', () => {
                    this._sendCallAction(ip, 'answer_call');
                });
                notification.addAction('Decline', () => {
                    this._sendCallAction(ip, 'decline_call');
                });

                this._notificationSource.addNotification(notification);
                this._currentCallNotify = notification;
            } else if (status === "IDLE" && this._lastCallStatus === "RINGING") {
                // Call ended or was picked up
                if (this._currentCallNotify) {
                    this._currentCallNotify.destroy();
                    this._currentCallNotify = null;
                }
            }

            this._lastCallStatus = status;
        }
        catch (e) {
            console.error(`Call polling error: ${e.message}`);
        }
    }

    _sendCallAction(ip, action) {
        try {
            const message = Soup.Message.new('POST', `http://${ip}:8080/${action}`);
            SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code === 200) {
                        console.log(`Call action ${action} successful`);
                        if (this._currentCallNotify) {
                            this._currentCallNotify.destroy();
                            this._currentCallNotify = null;
                        }
                    } else {
                        console.error(`Call action ${action} failed with status ${message.status_code}`);
                    }
                } catch (e) {
                    console.error(`Call action ${action} error: ${e.message}`);
                }
            });
        } catch (e) {
            console.error(`Call action request failed: ${e.message}`);
        }
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

        // 1. Ping the paired IP specifically
        console.log(`Phone HUB: Refreshing status for paired IP: ${pairedIp}`);
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
                const dialog = new PairingDialog((newIp) => {
                    Settings.saveSettings({ phoneIp: newIp });
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

        return true;
    }

    async _getDeviceMetadata(ip) {
        return new Promise((resolve) => {
            try {
                const message = Soup.Message.new('GET', `http://${ip}:8080/`);
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
                            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
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

        // --- Pair New Device item (Always Visible) ---
        let pairNewItem = new PopupMenu.PopupMenuItem('Pair New Device');
        pairNewItem.add_child(new St.Widget({ x_expand: true }))
        pairNewItem.add_child(new St.Icon({ icon_name: 'network-transmit-receive-symbolic' }));
        pairNewItem.connect('activate', () => {
            const dialog = new PairingDialog((ip) => {
                Settings.saveSettings({ phoneIp: ip });
                this.refreshDevices(true);
            });
            dialog.open();
        });
        this._deviceSection.addMenuItem(pairNewItem);

        if (visibleDevices.length === 0) {
            let infoItem = new PopupMenu.PopupMenuItem('No paired devices');
            infoItem.sensitive = false;
            this._deviceSection.addMenuItem(infoItem);
            this.subtitle = 'Disconnected';
        } else {
            visibleDevices.forEach(dev => {
                let connectionLabel = dev.isAdb ? `${dev.name} (ADB + Network)` : `${dev.name} (Network)`;
                this._addDeviceToMenu(dev.id, connectionLabel, !dev.isAdb, dev.isPaired);
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
                    const message = Soup.Message.new('POST', `http://${ip}:8080/pair`);
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

            let argv = ['gjs', '-m', scriptPath];
            if (ip) {
                argv.push('--host', ip);
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
            if (state) {
                this._startCallPolling();
            } else {
                this._stopCallPolling();
            }
        });

        if (isPaired) {
            deviceSubMenu.menu.addMenuItem(smsItem);
            deviceSubMenu.menu.addMenuItem(callNotifToggle);
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

        Settings.saveSettings({ phoneIp: "", deviceName: "" });
        this._isConnected = false;
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
        this._scanning = true;
    }
});

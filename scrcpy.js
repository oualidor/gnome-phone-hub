import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Adb from './adb.js';

/**
 * Get scrcpy path dynamically
 * @returns {string|null}
 */
export function getScrcpyPath() {
    // return '/opt/scrcpy/scrcpy'
    return GLib.find_program_in_path('scrcpy');
}

/**
 * Check if scrcpy is installed
 * @returns {boolean}
 */
export function checkScrcpy() {
    return !!getScrcpyPath();
}

/**
 * Check if camera is already running for a device
 * @param {string} deviceId 
 * @returns {boolean}
 */
export function isCameraRunning(deviceId) {
    try {
        let [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync('pgrep -a scrcpy');
        if (success && stdout) {
            let output = new TextDecoder().decode(stdout);
            let lines = output.split('\n');
            for (let line of lines) {
                if (line.includes('--video-source=camera') && line.includes(deviceId)) {
                    return true;
                }
            }
        }
        return false;
    } catch (e) {
        console.error(`Error checking camera status: ${e.message}`);
        return false;
    }
}

/**
 * Start camera using scrcpy
 * @param {string} deviceId 
 * @param {Object} procs - Object to store reference to the process
 * @param {Function} [onExit] - Callback to execute when the process exits
 */
export function startCamera(deviceId, procs, onExit = null) {
    const scrcpyPath = getScrcpyPath();
    if (!scrcpyPath) {
        Main.notify("Phone HUB", "scrcpy not found. Please install it to use this feature.");
        return;
    }

    try {
        let proc = Gio.Subprocess.new(
            [
                scrcpyPath,
                '-s', deviceId,
                '--no-window',
                '--video-source=camera',
                '--camera-facing=back',
                '--camera-size=1920x1080',
                '--max-fps=60',
                '--v4l2-sink=/dev/video42',
                '--no-audio',
                '--no-playback'
            ],
            Gio.SubprocessFlags.NONE
        );

        procs.camera = proc;

        proc.wait_async(null, () => {
            procs.camera = null;
            if (onExit) onExit();
        });
    } catch (e) {
        console.error(`Camera Error: ${e.message}`);
    }
}

/**
 * Start mirroring using scrcpy
 * @param {string} deviceId 
 * @param {Object} procs - Object to store reference to the process
 */
export function startMirroring(deviceId, procs) {
    const scrcpyPath = getScrcpyPath();
    if (!scrcpyPath) {
        Main.notify("Phone HUB", "scrcpy not found. Please install it to use this feature.");
        return;
    }

    try {
        let proc = Gio.Subprocess.new(
            [
                scrcpyPath,
                '-s', deviceId
            ],
            Gio.SubprocessFlags.NONE
        );

        procs.mirror = proc;

        proc.wait_async(null, () => {
            procs.mirror = null;
        });
    } catch (e) {
        console.error(`Mirror Error: ${e.message}`);
    }
}

/**
 * Start notification listener using adb logcat
 * @param {string} deviceId 
 * @param {Object} procs - Object to store reference to the process
 */
export function startNotificationListener(deviceId, procs) {
    const adbPath = Adb.getAdbPath() || 'adb';
    try {
        const argv = [
            adbPath, '-s', deviceId,
            'shell', 'logcat', '-b', 'events', '-v', 'brief', 'notification_enqueue:V', '*:S'
        ];

        let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);

        let stdoutStream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true
        });

        let lastNotifyTime = 0;

        const readLoop = () => {
            stdoutStream.read_line_async(GLib.PRIORITY_LOW, null, (stream, res) => {
                try {
                    let [line] = stream.read_line_finish_utf8(res);

                    if (line !== null) {
                        if (line.includes('notification_enqueue')) {
                            let now = Date.now();
                            if (now - lastNotifyTime > 2000) {
                                let pkg = line.match(/\[([^,\]]+)/)?.[1] || "Device";
                                Main.notify(`Phone HUB: ${pkg} (${deviceId})`, "New Notification Received");
                                lastNotifyTime = now;
                            }
                        }
                        readLoop();
                    }
                } catch (e) {
                    // Stream closed
                }
            });
        };

        readLoop();
        procs.notifications = proc;

    } catch (e) {
        console.error(`Notification Listener Error: ${e.message}`);
    }
}
/**
 * Start a specific app on a virtual display using scrcpy
 * @param {string} deviceId 
 * @param {string} packageName 
 * @param {number} width 
 * @param {number} height 
 * @param {Object} procs - Object to store reference to the process
 */
export function startApp(deviceId, packageName, width, height, procs) {
    const scrcpyPath = getScrcpyPath();
    if (!scrcpyPath) {
        Main.notify("Phone HUB", "scrcpy not found. Please install it to use this feature.");
        return;
    }

    try {
        const args = [
            scrcpyPath,
            '-s', deviceId,
            `--new-display=${width}x${height}`,
            `--start-app=${packageName}`
        ];
        console.log(`Phone HUB: Running scrcpy command: ${args.join(' ')}`);
        Main.notify('Phone HUB', `Starting scrcpy for ${packageName}...`);

        let proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDERR_PIPE);

        const stderrStream = new Gio.DataInputStream({
            base_stream: proc.get_stderr_pipe(),
            close_base_stream: true
        });

        const readError = () => {
            stderrStream.read_line_async(GLib.PRIORITY_LOW, null, (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line !== null) {
                        console.error(`Phone HUB (Scrcpy Error): ${line}`);
                        readError();
                    }
                } catch (e) { }
            });
        };
        readError();

        procs.app = proc;

        proc.wait_async(null, () => {
            procs.app = null;
        });
    } catch (e) {
        console.error(`App Launch Error: ${e.message}`);
    }
}

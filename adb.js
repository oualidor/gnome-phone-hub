import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Get ADB path dynamically
 * @returns {string|null}
 */
export function getAdbPath() {
    return GLib.find_program_in_path('adb');
}

/**
 * Check if ADB is functional
 * @returns {Promise<boolean>}
 */
export async function checkAdb() {
    const adbPath = getAdbPath();
    if (!adbPath) return false;

    let output = await runCommand([adbPath, 'version']);
    return output.includes('Android Debug Bridge');
}

/**
 * Async helper to run commands
 * @param {string[]} argv 
 * @returns {Promise<string>}
 */
export async function runCommand(argv) {
    return new Promise((resolve) => {
        try {
            let proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [, stdout] = p.communicate_utf8_finish(res);
                    resolve(stdout ?? '');
                } catch {
                    resolve('');
                }
            });
        } catch {
            resolve('');
        }
    });
}

/**
 * Get battery level of a device
 * @param {string} deviceId 
 * @returns {Promise<string>}
 */
export async function getBattery(deviceId) {
    const adbPath = getAdbPath() || 'adb';
    let output = await runCommand([
        adbPath,
        '-s', deviceId,
        'shell',
        'dumpsys',
        'battery'
    ]);

    let match = output.match(/level: (\d+)/);
    return match ? `Battery ${match[1]}%` : 'Battery ??%';
}

/**
 * Get list of connected devices
 * @returns {Promise<string[]>}
 */
export async function getDevices() {
    const adbPath = getAdbPath() || 'adb';
    let output = await runCommand([adbPath, 'devices']);

    let lines = output.split('\n');
    return lines
        .filter(line =>
            line &&
            !line.startsWith('List') &&
            line.includes('\tdevice')
        )
        .map(line => line.split('\t')[0].trim());
}

/**
 * Get all IPv4 addresses of a device
 * @param {string} deviceId 
 * @returns {Promise<string[]>}
 */
export async function getDeviceIps(deviceId) {
    const adbPath = getAdbPath() || 'adb';
    // Get all IP addresses
    let output = await runCommand([
        adbPath,
        '-s', deviceId,
        'shell',
        'ip', '-4', 'addr', 'show'
    ]);

    let ips = [];
    let lines = output.split('\n');
    for (let line of lines) {
        if (line.includes('inet ') && !line.includes('127.0.0.1')) {
            let match = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            if (match) {
                ips.push(match[1]);
            }
        }
    }
    return ips;
}
/**
 * Get list of installed launchable apps
 * @param {string} deviceId 
 * @returns {Promise<{name: string, package: string}[]>}
 */
export async function getInstalledApps(deviceId) {
    const adbPath = getAdbPath() || 'adb';
    // This command gets all launchable activities and their labels
    // It's a bit complex but reliable: cmd package list packages -3 (third party)
    // or just list all packages. 
    // To get the labels, we can use: pm list packages -e
    // Actually, getting labels via ADB is slow if we do it one by one.
    // A better way is: 'shell', 'pm', 'query-activities', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'
    // but query-activities doesn't exist on all Android versions.

    // Simplest reliable way: list all packages, then we'll show package names if we can't get labels easily.
    // However, users prefer names.
    let output = await runCommand([
        adbPath,
        '-s', deviceId,
        'shell',
        'pm', 'list', 'packages', '-3'
    ]);

    let packages = output.split('\n')
        .filter(line => line.trim().startsWith('package:'))
        .map(line => line.replace('package:', '').trim())
        .filter(p => p.length > 0)
        .sort();

    return packages.map(p => ({
        name: p.split('.').pop().charAt(0).toUpperCase() + p.split('.').pop().slice(1),
        package: p
    }));
}

/**
 * Enable TCP/IP mode on a device (via USB)
 * @param {string} deviceId 
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
export async function enableTcpip(deviceId, port = 5555) {
    const adbPath = getAdbPath() || 'adb';
    let output = await runCommand([adbPath, '-s', deviceId, 'tcpip', port.toString()]);
    return output.toLowerCase().includes('restarting in tcp mode');
}

/**
 * Connect to a device via IP
 * @param {string} ip 
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
export async function connectIp(ip, port = 5555) {
    const adbPath = getAdbPath() || 'adb';
    let output = await runCommand([adbPath, 'connect', `${ip}:${port}`]);
    return output.toLowerCase().includes('connected to');
}

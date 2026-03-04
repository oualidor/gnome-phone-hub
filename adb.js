import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Get ADB path dynamically
 * @returns {string|null}
 */
export function getAdbPath() {
    return '/usr/bin/adb'
    // return GLib.find_program_in_path('adb');
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

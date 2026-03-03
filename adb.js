import Gio from 'gi://Gio';

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
    let output = await runCommand([
        '/usr/bin/adb',
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
    let output = await runCommand(['/usr/bin/adb', 'devices']);

    let lines = output.split('\n');
    return lines
        .filter(line =>
            line &&
            !line.startsWith('List') &&
            line.includes('\tdevice')
        )
        .map(line => line.split('\t')[0].trim());
}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const SoupSession = new Soup.Session();
SoupSession.timeout = 2; // Time out quickly for unresponsive IPs

/**
 * Identify the local subnet
 * @returns {Promise<{ip: string, mask: string}|null>}
 */
export async function findLocalSubnet() {
    return new Promise((resolve) => {
        try {
            let proc = Gio.Subprocess.new(
                ['ip', '-4', 'addr', 'show'],
                Gio.SubprocessFlags.STDOUT_PIPE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [, stdout] = p.communicate_utf8_finish(res);
                    if (!stdout) {
                        resolve(null);
                        return;
                    }
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        // Look for global dynamic IPs (usually the main network interface)
                        if (line.includes('inet ') && !line.includes('127.0.0.1')) {
                            const match = line.trim().match(/inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
                            if (match) {
                                resolve({ ip: match[1], mask: match[2] });
                                return;
                            }
                        }
                    }
                    resolve(null);
                } catch (e) {
                    console.error(`Subnet detection error: ${e.message}`);
                    resolve(null);
                }
            });
        } catch (e) {
            console.error(`Subnet detection process error: ${e.message}`);
            resolve(null);
        }
    });
}

/**
 * Scan the subnet for Phone HUB Servers
 * @param {object} subnet {ip, mask}
 * @returns {Promise<string[]>} List of discovered IPs
 */
export async function scanNetwork(subnet) {
    if (!subnet) return [];
    if (subnet.mask !== '24') {
        console.warn(`Subnet mask /${subnet.mask} not fully supported for auto-scan. Scanning /24 range of ${subnet.ip}`);
    }

    const baseIp = subnet.ip.split('.').slice(0, 3).join('.');
    const discovered = [];
    const batchSize = 50; // Scan in batches to avoid overwhelming the session

    for (let i = 1; i < 255; i += batchSize) {
        const batch = [];
        for (let j = i; j < i + batchSize && j < 255; j++) {
            const targetIp = `${baseIp}.${j}`;
            if (targetIp === subnet.ip) continue;

            batch.push(new Promise((resolve) => {
                const message = Soup.Message.new('GET', `http://${targetIp}:8080/ping`);
                SoupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                    try {
                        const bytes = session.send_and_read_finish(res);
                        if (message.status_code === 200) {
                            const decoder = new TextDecoder('utf-8');
                            const response = decoder.decode(bytes.toArray());
                            if (response.trim() === 'pong') {
                                discovered.push(targetIp);
                            }
                        }
                    } catch (e) {
                        // Most IPs will fail, it's expected
                    }
                    resolve();
                });
            }));
        }
        await Promise.all(batch);
    }

    return discovered;
}

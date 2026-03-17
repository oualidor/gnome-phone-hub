import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Get all paired Bluetooth devices from BlueZ via D-Bus.
 * @returns {Promise<Array<{address: string, name: string, connected: boolean, path: string}>>}
 */
export async function getPairedDevices() {
    return new Promise((resolve) => {
        try {
            const bus = Gio.DBus.system;
            bus.call(
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects',
                null,
                new GLib.VariantType('(a{oa{sa{sv}}})'),
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                (connection, res) => {
                    try {
                        const result = connection.call_finish(res);
                        const objects = result.get_child_value(0);
                        const devices = [];

                        const nObjects = objects.n_children();
                        for (let i = 0; i < nObjects; i++) {
                            const entry = objects.get_child_value(i);
                            const path = entry.get_child_value(0).get_string()[0];
                            const interfaces = entry.get_child_value(1);

                            const nInterfaces = interfaces.n_children();
                            for (let j = 0; j < nInterfaces; j++) {
                                const iface = interfaces.get_child_value(j);
                                const ifaceName = iface.get_child_value(0).get_string()[0];

                                if (ifaceName === 'org.bluez.Device1') {
                                    const props = iface.get_child_value(1);
                                    let address = '', name = '', paired = false, connected = false;

                                    const nProps = props.n_children();
                                    for (let k = 0; k < nProps; k++) {
                                        const prop = props.get_child_value(k);
                                        const propName = prop.get_child_value(0).get_string()[0];
                                        const propVal = prop.get_child_value(1).get_variant();

                                        if (propName === 'Address') address = propVal.get_string()[0];
                                        else if (propName === 'Name') name = propVal.get_string()[0];
                                        else if (propName === 'Paired') paired = propVal.get_boolean();
                                        else if (propName === 'Connected') connected = propVal.get_boolean();
                                    }

                                    if (paired) {
                                        devices.push({ address, name, connected, path });
                                    }
                                }
                            }
                        }

                        resolve(devices);
                    } catch (e) {
                        console.error(`Phone HUB BT: Failed to parse BlueZ objects: ${e.message}`);
                        resolve([]);
                    }
                }
            );
        } catch (e) {
            console.error(`Phone HUB BT: Failed to query BlueZ: ${e.message}`);
            resolve([]);
        }
    });
}

/**
 * Find the BT MAC of a paired device by its name.
 * Queries BlueZ for all paired devices and matches by name.
 * @param {string} deviceName - The device name to search for
 * @returns {Promise<string|null>} The BT MAC address, or null if not found
 */
export async function findPhoneBtMac(deviceName) {
    if (!deviceName) return null;

    const devices = await getPairedDevices();
    // Match by name (case-insensitive)
    const match = devices.find(d => d.name.toLowerCase() === deviceName.toLowerCase());
    if (match) {
        console.log(`Phone HUB BT: Found paired device "${match.name}" with MAC: ${match.address}`);
        return match.address;
    }

    console.log(`Phone HUB BT: No paired BT device found matching name "${deviceName}"`);
    return null;
}

/**
 * Request the phone's current WiFi IP via Bluetooth RFCOMM.
 * Uses Python3's built-in socket module (AF_BLUETOOTH) — no pip packages needed.
 *
 * @param {string} btMac - Bluetooth MAC address of the phone
 * @returns {Promise<string|null>} The phone's current WiFi IP, or null on failure
 */
export async function requestIpViaBluetooth(btMac) {
    if (!btMac) return null;

    return new Promise((resolve) => {
        try {
            const script = `
import socket, json, sys, subprocess, re

mac = sys.argv[1]
uuid = "550e8400-e29b-41d4-a716-446655440000"

def find_rfcomm_channel():
    """Try sdptool to find the RFCOMM channel for our UUID."""
    try:
        out = subprocess.check_output(
            ["sdptool", "browse", "--uuid", "0x0003", mac],
            timeout=10, stderr=subprocess.DEVNULL
        ).decode()
        # Look for our UUID in the SDP records and get the channel
        blocks = out.split("Service Name:")
        for block in blocks:
            if "PhoneHUB" in block or uuid in block.lower():
                m = re.search(r"Channel:\\s*(\\d+)", block)
                if m:
                    return int(m.group(1))
    except Exception:
        pass
    return None

def try_connect(channel):
    """Try connecting to a specific RFCOMM channel."""
    sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    sock.settimeout(5)
    sock.connect((mac, channel))
    sock.send(b"IP_REQUEST")
    data = sock.recv(1024)
    sock.close()
    return json.loads(data.decode()).get("ip", "")

# Strategy 1: SDP lookup
channel = find_rfcomm_channel()
if channel:
    try:
        ip = try_connect(channel)
        if ip:
            print(ip)
            sys.exit(0)
    except Exception:
        pass

# Strategy 2: Try channels 1-10
for ch in range(1, 11):
    try:
        ip = try_connect(ch)
        if ip:
            print(ip)
            sys.exit(0)
    except Exception:
        continue

print("", file=sys.stderr)
sys.exit(1)
`;

            const proc = Gio.Subprocess.new(
                ['python3', '-c', script, btMac],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );

            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (p.get_successful() && stdout) {
                        const ip = stdout.trim();
                        if (ip && ip !== '' && !ip.startsWith('ERROR')) {
                            console.log(`Phone HUB BT: Got IP via Bluetooth: ${ip}`);
                            resolve(ip);
                            return;
                        }
                    }
                    if (stderr && stderr.trim()) {
                        console.error(`Phone HUB BT: RFCOMM error: ${stderr.trim()}`);
                    }
                    resolve(null);
                } catch (e) {
                    console.error(`Phone HUB BT: Process error: ${e.message}`);
                    resolve(null);
                }
            });
        } catch (e) {
            console.error(`Phone HUB BT: Failed to spawn process: ${e.message}`);
            resolve(null);
        }
    });
}

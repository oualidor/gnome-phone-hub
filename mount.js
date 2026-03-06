import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Check if sshfs is installed
 * @returns {boolean}
 */
export function checkSshfs() {
    return !!GLib.find_program_in_path('sshfs');
}

/**
 * Check if the mount point is currently mounted
 * @param {string} mountPoint 
 * @returns {boolean}
 */
export function isMounted(mountPoint) {
    try {
        // GLib.spawn_command_line_sync returns [success, stdout, stderr, exit_status]
        let [success, , , status] = GLib.spawn_command_line_sync(`mountpoint -q "${mountPoint}"`);
        return success && status === 0;
    } catch (e) {
        return false;
    }
}

/**
 * Mount the phone using sshfs
 * @param {string} ip 
 * @param {Object} settings 
 * @returns {Promise<boolean>}
 */
export async function mountDevice(ip, settings) {
    if (!checkSshfs()) {
        console.log('sshfs is not installed');
        throw new Error('sshfs is not installed');
    }

    const mountPoint = settings.sshfsMountPoint;
    const port = settings.sshfsPort || '2222';
    const user = settings.sshfsUser || 'phonehub';
    const remotePath = settings.sshfsPath || '/';
    const password = settings.restToken;

    if (!password) {
        throw new Error('Device not paired securely (missing token)');
    }

    // Ensure mount point exists
    const dir = Gio.File.new_for_path(mountPoint);
    if (!dir.query_exists(null)) {
        dir.make_directory_with_parents(null);
    }

    // if (isMounted(mountPoint)) {
    //     return true; // Already mounted
    // }

    // sshpass -p password sshfs user@ip:remotePath mountPoint -p port ...
    const argv = [
        'sshpass',
        '-p', password,
        'sshfs',
        `${user}@${ip}:`,
        mountPoint,
        '-p', port,
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'PasswordAuthentication=yes',
        '-o', 'PreferredAuthentications=password',
        '-o', 'GSSAPIAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no',
        '-d'
    ];

    console.log(`Mounting with token length: ${password.length}, prefix: ${password.substring(0, 4)}`);

    return new Promise((resolve, reject) => {
        console.log(argv);
        console.log('monting device')
        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.wait_async(null, (p, res) => {
                try {
                    if (p.wait_finish(res)) {
                        resolve(true);
                    } else {
                        // Get stderr for error reporting
                        let stderr = p.get_stderr_pipe();
                        if (stderr) {
                            let stream = new Gio.DataInputStream({ base_stream: stderr });
                            let [line] = stream.read_line_utf8(null);
                            reject(new Error(line || 'Failed to mount'));
                        } else {
                            reject(new Error('Failed to mount'));
                        }
                    }
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            console.log(e);
            reject(e);
        }
    });
}

/**
 * Unmount the phone
 * @param {string} mountPoint 
 * @returns {Promise<boolean>}
 */
export async function unmountDevice(mountPoint) {
    if (!isMounted(mountPoint)) {
        return true; // Already unmounted
    }

    // Try fusermount3 first (modern), then fallback to fusermount
    let unmountCmd = GLib.find_program_in_path('fusermount3') ? 'fusermount3' : 'fusermount';
    const argv = [unmountCmd, '-u', '-z', mountPoint]; // -z for lazy unmount if busy or hung

    return new Promise((resolve, reject) => {
        try {
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.wait_async(null, (p, res) => {
                try {
                    if (p.wait_finish(res)) {
                        resolve(true);
                    } else {
                        reject(new Error('Failed to unmount'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

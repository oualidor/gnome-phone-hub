/**
 * screenStream.js – GNOME Shell extension module (runs inside GNOME Shell process).
 * Connects to the phone's /stream WebSocket and pipes binary frames into screenStreamWindow.js.
 * The viewer runs as a separate GJS subprocess so that GTK/GStreamer are NOT imported in Shell.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

let _ws = null;
let _viewerProc = null;
let _viewerStdin = null;
let _reconnectTimer = null;

/**
 * Open the stream WebSocket and launch the viewer subprocess.
 * @param {string} ip     Phone IP address
 * @param {string} token  wsToken saved during pairing
 * @param {string} extensionPath  Absolute path to the extension directory
 */
export function start(ip, token, extensionPath) {
    if (_ws) stop(); // Cleanup any existing stream

    // 1. Launch the GTK viewer subprocess (passes host & token for the control WebSocket)
    const scriptPath = `${extensionPath}/screenStreamWindow.js`;
    try {
        _viewerProc = Gio.Subprocess.new(
            ['gjs', '-m', scriptPath, '--host', ip, '--token', token],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        _viewerStdin = _viewerProc.get_stdin_pipe();
        console.log('[ScreenStream] Viewer process started');
    } catch (e) {
        console.error(`[ScreenStream] Failed to start viewer: ${e.message}`);
        return;
    }

    // 2. Connect to the WebSocket stream endpoint on the phone
    const session = new Soup.Session({ timeout: 10 });
    const msg = new Soup.Message({
        method: 'GET',
        uri: GLib.Uri.parse(`ws://${ip}:8080/stream?token=${encodeURIComponent(token)}`, GLib.UriFlags.NONE),
    });

    session.websocket_connect_async(msg, null, null, null, null, (_sess, res) => {
        try {
            _ws = session.websocket_connect_finish(res);
        } catch (e) {
            console.error(`[ScreenStream] WebSocket connect failed: ${e.message}`);
            stop();
            return;
        }

        _ws.connect('message', (_conn, type, data) => {
            if (type !== Soup.WebsocketDataType.BINARY) return;
            if (!_viewerStdin) return;

            try {
                const bytes = data.toArray();
                const len = bytes.byteLength;

                // Write 4-byte big-endian length prefix then payload
                const header = new Uint8Array(4);
                header[0] = (len >>> 24) & 0xff;
                header[1] = (len >>> 16) & 0xff;
                header[2] = (len >>> 8) & 0xff;
                header[3] = len & 0xff;

                _viewerStdin.write_all(header, null);
                _viewerStdin.write_all(bytes, null);
            } catch (e) {
                console.warn(`[ScreenStream] Write error: ${e.message}`);
                stop();
            }
        });

        _ws.connect('closed', () => {
            console.log('[ScreenStream] WebSocket closed');
            stop();
        });

        _ws.connect('error', (_conn, err) => {
            console.error(`[ScreenStream] WebSocket error: ${err.message}`);
            stop();
        });

        console.log('[ScreenStream] WebSocket connected, streaming started');
    });
}

/**
 * Stop the stream and clean up all resources.
 */
export function stop() {
    if (_reconnectTimer) {
        GLib.source_remove(_reconnectTimer);
        _reconnectTimer = null;
    }

    try { _ws?.close(1000, 'Stop requested'); } catch (_) { }
    _ws = null;

    try { _viewerStdin?.close(null); } catch (_) { }
    _viewerStdin = null;

    try { _viewerProc?.force_exit(); } catch (_) { }
    _viewerProc = null;

    console.log('[ScreenStream] Stopped');
}

export function isStreaming() {
    return _ws !== null;
}

#!/usr/bin/gjs
/**
 * screenStreamWindow.js – Standalone GJS process (NOT part of GNOME Shell).
 *
 * • Reads length-prefixed H.264 frames from stdin and renders them via GStreamer.
 * • Opens a /control WebSocket back to the phone and forwards:
 *     - mouse clicks  → tap commands
 *     - mouse drags   → swipe commands
 *     - key presses   → key / text commands
 *
 * CLI args:  --host <ip>  --token <wsToken>
 *
 * Required packages:
 *   gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav
 *   gstreamer1.0-gtk3 or gst-plugins-good (for gtk4paintablesink)
 */

import System from 'system';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gst from 'gi://Gst';
import Soup from 'gi://Soup?version=3.0';

// ── Parse CLI arguments ────────────────────────────────────────────────────
const args = System.programArgs;
let phoneHost = null;
let wsToken = '';
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) phoneHost = args[i + 1];
    if (args[i] === '--token' && args[i + 1]) wsToken = args[i + 1];
}

Gst.init(null);
Gtk.init();

// ── Control WebSocket ──────────────────────────────────────────────────────
let controlWs = null;

function openControlSocket() {
    if (!phoneHost || !wsToken) return;

    const session = new Soup.Session({ timeout: 5 });
    const msg = new Soup.Message({
        method: 'GET',
        uri: GLib.Uri.parse(
            `ws://${phoneHost}:8080/control?token=${encodeURIComponent(wsToken)}`,
            GLib.UriFlags.NONE
        ),
    });

    session.websocket_connect_async(msg, null, null, null, null, (_sess, res) => {
        try {
            controlWs = session.websocket_connect_finish(res);
            console.log('[Control] WebSocket connected');

            controlWs.connect('message', (_conn, type, data) => {
                // Server may send JSON error messages
                if (type === Soup.WebsocketDataType.TEXT) {
                    console.warn(`[Control] Server: ${new TextDecoder().decode(data.toArray())}`);
                }
            });
            controlWs.connect('closed', () => { controlWs = null; });
            controlWs.connect('error', (_conn, err) => { console.error(`[Control] ${err.message}`); });
        } catch (e) {
            console.warn(`[Control] Connect failed: ${e.message}`);
        }
    });
}

function sendControl(obj) {
    if (!controlWs) return;
    try {
        controlWs.send_text(JSON.stringify(obj));
    } catch (_) { }
}

// ── GTK Application ───────────────────────────────────────────────────────
const app = new Gtk.Application({ application_id: 'org.phonehub.ScreenStream' });

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Phone HUB – Screen Stream',
        default_width: 400,
        default_height: 700,
    });

    // ─ GStreamer pipeline ─────────────────────────────────────────────────
    let pipeline, appSrc;
    try {
        pipeline = Gst.parse_launch(
            'appsrc name=src format=time is-live=true block=false max-buffers=3 ' +
            '! h264parse ' +
            '! avdec_h264 ' +
            '! videoconvert ' +
            '! gtk4paintablesink name=sink'
        );
    } catch (e) {
        console.error(`GStreamer pipeline error: ${e.message}`);
        console.error('Install: gstreamer1.0-plugins-good gstreamer1.0-libav gstreamer1.0-gtk');
        app.quit();
        return;
    }

    appSrc = pipeline.get_by_name('src');
    const sink = pipeline.get_by_name('sink');

    const picture = new Gtk.Picture({
        can_shrink: true,
        hexpand: true,
        vexpand: true,
    });
    picture.set_paintable(sink.get_property('paintable'));

    // ─ Overlay: on-screen key buttons ────────────────────────────────────
    const backBtn = Gtk.Button.new_with_label('◀ Back');
    const homeBtn = Gtk.Button.new_with_label('⏏ Home');
    const recBtn = Gtk.Button.new_with_label('⧉ Recents');

    backBtn.connect('clicked', () => sendControl({ type: 'key', key: 'BACK' }));
    homeBtn.connect('clicked', () => sendControl({ type: 'key', key: 'HOME' }));
    recBtn.connect('clicked', () => sendControl({ type: 'key', key: 'RECENTS' }));

    const btnBar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, homogeneous: true });
    [backBtn, homeBtn, recBtn].forEach(b => btnBar.append(b));

    const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    vbox.append(picture);
    vbox.append(btnBar);
    window.set_child(vbox);

    // ─ Input: mouse clicks → tap / swipe ─────────────────────────────────
    let pressX = 0, pressY = 0, pressTime = 0;

    const pressGesture = new Gtk.GestureClick();
    pressGesture.connect('pressed', (_g, _n, x, y) => {
        pressX = x; pressY = y; pressTime = Date.now();
    });
    pressGesture.connect('released', (_g, _n, x, y) => {
        const w = picture.get_width();
        const h = picture.get_height();
        if (w === 0 || h === 0) return;

        const dx = Math.abs(x - pressX);
        const dy = Math.abs(y - pressY);
        const elapsed = Date.now() - pressTime;

        if (dx < 10 && dy < 10 && elapsed < 300) {
            // Tap
            sendControl({ type: 'tap', x: x / w, y: y / h });
        } else {
            // Swipe
            sendControl({
                type: 'swipe',
                x1: pressX / w, y1: pressY / h,
                x2: x / w, y2: y / h,
                duration: Math.min(elapsed, 1000),
            });
        }
    });
    picture.add_controller(pressGesture);

    // ─ Input: keyboard → text / key ──────────────────────────────────────
    const keyCtrl = new Gtk.EventControllerKey();
    keyCtrl.connect('key-pressed', (_ctrl, keyval, _code, _state) => {
        switch (keyval) {
            case Gdk.KEY_Escape: sendControl({ type: 'key', key: 'BACK' }); break;
            case Gdk.KEY_Super_L:
            case Gdk.KEY_Super_R: sendControl({ type: 'key', key: 'HOME' }); break;
            case Gdk.KEY_Tab: sendControl({ type: 'key', key: 'RECENTS' }); break;
            case Gdk.KEY_VolumeUp: sendControl({ type: 'key', key: 'VOLUME_UP' }); break;
            case Gdk.KEY_VolumeDown: sendControl({ type: 'key', key: 'VOLUME_DOWN' }); break;
            default: {
                const ch = Gdk.keyval_to_unicode(keyval);
                if (ch > 31) sendControl({ type: 'text', text: String.fromCodePoint(ch) });
            }
        }
        return true;
    });
    window.add_controller(keyCtrl);

    window.present();
    pipeline.set_state(Gst.State.PLAYING);

    // ─ Open control WebSocket ─────────────────────────────────────────────
    openControlSocket();

    // ─ Read video frames from stdin ───────────────────────────────────────
    const stdin = new Gio.DataInputStream({
        base_stream: new Gio.UnixInputStream({ fd: 0, close_fd: false }),
        byte_order: Gio.DataStreamByteOrder.BIG_ENDIAN,
    });

    function readNextFrame() {
        stdin.read_bytes_async(4, GLib.PRIORITY_DEFAULT, null, (_s, res1) => {
            let lenBytes;
            try { lenBytes = stdin.read_bytes_finish(res1); } catch { app.quit(); return; }
            if (!lenBytes || lenBytes.get_size() < 4) { app.quit(); return; }

            const b = lenBytes.toArray();
            const len = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];

            stdin.read_bytes_async(len, GLib.PRIORITY_DEFAULT, null, (_s2, res2) => {
                let payload;
                try { payload = stdin.read_bytes_finish(res2); } catch { app.quit(); return; }
                if (!payload || payload.get_size() === 0) { app.quit(); return; }

                const buf = Gst.Buffer.new_wrapped(payload.toArray());
                appSrc.emit('push-buffer', buf);
                readNextFrame();
            });
        });
    }

    readNextFrame();

    window.connect('close-request', () => {
        try { controlWs?.close(1000, 'bye'); } catch (_) { }
        pipeline.set_state(Gst.State.NULL);
        app.quit();
    });
});

app.run([]);

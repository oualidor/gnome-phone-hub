#!/usr/bin/gjs
/**
 * callWindow.js – Standalone GJS script for displaying an incoming call UI.
 *
 * CLI args: --host <ip> --token <rest_token> --number <caller_id>
 */

import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

try {
    let host = '127.0.0.1';
    let token = '';
    let number = 'Unknown Caller';
    let statusstr = 'ringing';

    for (let i = 0; i < ARGV.length; i++) {
        if (ARGV[i] === '--host' && ARGV[i + 1]) host = ARGV[i + 1];
        if (ARGV[i] === '--token' && ARGV[i + 1]) token = ARGV[i + 1];
        if (ARGV[i] === '--number' && ARGV[i + 1]) number = ARGV[i + 1];
        if (ARGV[i] === '--status' && ARGV[i + 1]) statusstr = ARGV[i + 1].toLowerCase();
    }

    const app = new Gtk.Application({
        application_id: 'com.oualidkhial.phonehub.call.' + Date.now(),
        flags: Gio.ApplicationFlags.FLAGS_NONE
    });

    const session = new Soup.Session();

    app.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({
            application: app,
            title: statusstr === 'offhook' ? 'Ongoing Call' : 'Incoming Call',
            default_width: 400,
            // default_height: 200,
            resizable: false,
            decorated: false, // Make it look like a floating widget
        });

        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 32,
            margin_end: 32,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });

        // Avatar
        const avatarImage = new Gtk.Image({
            icon_name: 'avatar-default-symbolic',
            pixel_size: 34,
            halign: Gtk.Align.CENTER,
            margin_bottom: 8
        });
        avatarImage.add_css_class('avatar');
        mainBox.append(avatarImage);

        // Caller ID
        const callerLabel = new Gtk.Label({
            label: number,
            halign: Gtk.Align.CENTER,
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        callerLabel.add_css_class('title-2');
        mainBox.append(callerLabel);

        // Title/Status
        const titleLabel = new Gtk.Label({
            label: statusstr === 'offhook' ? 'Ongoing Call' : 'Incoming Call',
            halign: Gtk.Align.CENTER,
        });
        titleLabel.add_css_class('body');
        titleLabel.add_css_class('dim-label');
        mainBox.append(titleLabel);

        // Buttons
        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 48,
            halign: Gtk.Align.CENTER,
            margin_top: 24,
        });

        // Decline Button (Red)
        const declineBtn = new Gtk.Button({
            icon_name: 'call-stop-symbolic',
            has_frame: true,
        });
        declineBtn.set_size_request(56, 56);
        declineBtn.add_css_class('circular');
        declineBtn.add_css_class('destructive-action');
        declineBtn.add_css_class('osd');
        declineBtn.connect('clicked', () => {
            sendCallAction('decline_call');
        });
        btnBox.append(declineBtn);

        // Accept Button (Green) - only for incoming calls
        if (statusstr === 'ringing') {
            const acceptBtn = new Gtk.Button({
                icon_name: 'call-start-symbolic',
                has_frame: true,
            });
            acceptBtn.set_size_request(56, 56);
            acceptBtn.add_css_class('circular');
            acceptBtn.add_css_class('suggested-action');
            acceptBtn.add_css_class('osd');
            acceptBtn.connect('clicked', () => {
                sendCallAction('answer_call');
            });
            btnBox.append(acceptBtn);
        }

        mainBox.append(btnBox);
        window.set_child(mainBox);
        window.present();

        // Listen for stdin to cleanly close the window from toggle.js
        const stdinStream = new Gio.DataInputStream({
            base_stream: new Gio.UnixInputStream({ fd: 0, close_fd: false })
        });
        const readStdin = () => {
            stdinStream.read_line_async(GLib.PRIORITY_LOW, null, (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line) {
                        const text = line.trim();
                        if (text === 'CLOSE') {
                            app.quit();
                        } else if (text.startsWith('CLOSE_DELAYED:')) {
                            titleLabel.set_text(text.substring(14));
                            mainBox.set_sensitive(false);
                            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                                app.quit();
                                return GLib.SOURCE_REMOVE;
                            });
                        } else if (text.startsWith('STATUS:')) {
                            titleLabel.set_text(text.substring(7));
                            readStdin();
                        } else if (text.startsWith('UPDATE:')) {
                            callerLabel.set_text(text.substring(7));
                            readStdin();
                        } else {
                            readStdin();
                        }
                    } else if (line !== null) {
                        readStdin();
                    }
                } catch (e) { }
            });
        };
        readStdin();
    });

    function sendCallAction(action) {
        console.log(`Phone HUB: Sending call action '${action}' to ${host}...`);
        const url = `http://${host}:8080/${action}?token=${token}`;
        const message = Soup.Message.new('POST', url);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                session.send_and_read_finish(res);
                console.log(`Phone HUB: Call action '${action}' completed.`);
            } catch (e) {
                console.error(`Phone HUB: Failed call action: ${e.message}`);
            }
            // Always quit immediately after action to close the window
            app.quit();
        });
    }

    app.run(null);
} catch (e) {
    console.error(`Phone HUB: Call Window Error: ${e.message}`);
}

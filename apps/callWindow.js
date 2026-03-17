#!/usr/bin/gjs
/**
 * callWindow.js – Standalone GJS script for displaying an incoming call UI.
 *
 * CLI args: --host <ip> --token <rest_token> --number <caller_id>
 */

const Gdk = imports.gi.Gdk;

import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

try {

    let host = '127.0.0.1';
    let token = '';
    let number = 'Unknown Caller';
    let statusstr = 'ringing';


    const USER_DATA_DIR = GLib.get_user_data_dir()

    let cssFile = Gio.File.new_for_path(USER_DATA_DIR + '/gnome-shell/extensions/phone-hub@oualidkhial/callWindow.css');


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

        let cssFile = Gio.File.new_for_path(USER_DATA_DIR + '/gnome-shell/extensions/phone-hub@oualidkhial/callWindow.css');


        let provider = new Gtk.CssProvider();
        provider.load_from_file(cssFile);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);


        const window = new Gtk.ApplicationWindow({
            application: app,
            title: statusstr === 'offhook' ? 'Ongoing Call' : 'Incoming Call',
            default_width: 350,
            resizable: false,
            decorated: false,
        });
        window.add_css_class('callWindow');

        // The main container is now vertical to hold the profile row + buttons
        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 24,
            margin_end: 12,
        });
        mainBox.add_css_class('mainBox');

        // --- PROFILE ROW (Avatar + Text) ---
        const profileRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 16,
            halign: Gtk.Align.START,
            valign: Gtk.Align.CENTER
        });


        // Avatar (Left)
        const avatarImage = new Gtk.Image({
            icon_name: 'avatar-default-symbolic',
            pixel_size: 48, // Slightly larger for better balance
            valign: Gtk.Align.CENTER,
        });
        avatarImage.add_css_class('avatar');
        profileRow.append(avatarImage);

        // Text Container (Vertical Stack)
        const textStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            valign: Gtk.Align.CENTER
        });

        // Caller Name/Number
        const callerLabel = new Gtk.Label({
            label: number,
            halign: Gtk.Align.START, // Left align text
            use_markup: true,
        });
        callerLabel.add_css_class('idLabel');
        textStack.append(callerLabel);

        // Status Label (Under Name)
        const titleLabel = new Gtk.Label({
            label: (statusstr === 'offhook' ? 'Ongoing Call' : 'Incoming Call').toUpperCase(),
            halign: Gtk.Align.START,
        });
        titleLabel.add_css_class('caption'); // Smaller font
        textStack.append(titleLabel);

        profileRow.append(textStack);
        mainBox.append(profileRow);

        // --- BUTTONS ---
        const btnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 24,
            halign: Gtk.Align.END, // Moves buttons to bottom right for a modern look
            margin_top: 12,
        });

        // Decline Button (Red)
        const declineBtn = new Gtk.Button({
            icon_name: 'call-stop-symbolic',
        });
        declineBtn.set_size_request(48, 48);
        declineBtn.add_css_class('circular');
        declineBtn.add_css_class('destructive-action');
        declineBtn.connect('clicked', () => {
            sendCallAction('decline_call');
        });
        btnBox.append(declineBtn);

        // Accept Button (Green)
        if (statusstr === 'ringing') {
            const acceptBtn = new Gtk.Button({
                icon_name: 'call-start-symbolic',
            });
            acceptBtn.set_size_request(48, 48);
            acceptBtn.add_css_class('circular');
            acceptBtn.add_css_class('suggested-action');
            acceptBtn.connect('clicked', () => {
                sendCallAction('answer_call');
            });
            btnBox.append(acceptBtn);
        }

        mainBox.append(btnBox);
        window.set_child(mainBox);

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
                            const newStatus = text.substring(7);
                            titleLabel.set_text(newStatus);
                            readStdin();
                        } else if (text.startsWith('UPDATE:')) {
                            callerLabel.set_text(text.substring(7));
                            readStdin();
                        } else if (text.startsWith('JSON_UPDATE:')) {
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

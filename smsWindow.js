#!/usr/bin/gjs

import System from 'system';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import GObject from 'gi://GObject';

let SMS_URL = 'http://localhost:8080/sms';
let TOKEN = '';

// Parse arguments
const args = System.arguments;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host' && args[i + 1]) {
        SMS_URL = `http://${args[i + 1]}:8080/sms`;
    }
    if (args[i] === '--token' && args[i + 1]) {
        TOKEN = args[i + 1];
    }
}

if (TOKEN) {
    SMS_URL += `?token=${TOKEN}`;
}
const STORAGE_DIR = GLib.get_user_data_dir() + '/phone-hub';
const STORAGE_PATH = STORAGE_DIR + '/sms_history.json';

console.log('SMS Window: Script starting...');
console.log('SMS Window: DISPLAY=', GLib.getenv('DISPLAY'));
console.log('SMS Window: WAYLAND_DISPLAY=', GLib.getenv('WAYLAND_DISPLAY'));

class MessageStore {
    constructor() {
        this.messages = [];
        this.load();
    }

    load() {
        const file = Gio.File.new_for_path(STORAGE_PATH);
        if (!file.query_exists(null)) {
            this.messages = [];
            return;
        }

        try {
            const [success, contents] = file.load_contents(null);
            if (success) {
                const decoder = new TextDecoder('utf-8');
                this.messages = JSON.parse(decoder.decode(contents));
            }
        } catch (e) {
            console.error(`Error loading messages: ${e.message}`);
            this.messages = [];
        }
    }

    save() {
        try {
            const dir = Gio.File.new_for_path(STORAGE_DIR);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            const file = Gio.File.new_for_path(STORAGE_PATH);
            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(this.messages, null, 2));
            file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`Error saving messages: ${e.message}`);
        }
    }

    addMessages(newMessages) {
        let changed = false;
        newMessages.forEach(msg => {
            const sender = msg.sender || msg.sende || 'Unknown';
            const body = msg.body || '';
            const timestamp = msg.timestamp || Date.now();
            const remote_party = msg.remote_party || null;

            // Check for duplicates
            const exists = this.messages.some(m =>
                m.sender === sender &&
                m.body === body &&
                Math.abs(m.timestamp - timestamp) < 1000 // Small time difference allowed
            );

            if (!exists) {
                this.messages.push({ sender, body, timestamp, remote_party });
                changed = true;
            }
        });

        if (changed) {
            this.messages.sort((a, b) => b.timestamp - a.timestamp);
            this.save();
        }
        return changed;
    }

    getConversations() {
        const convos = new Map();
        [...this.messages].sort((a, b) => b.timestamp - a.timestamp).forEach(msg => {
            const contact = (msg.sender === 'Me') ? msg.remote_party : msg.sender;
            if (!contact) return;
            if (!convos.has(contact)) {
                convos.set(contact, []);
            }
            convos.get(contact).push(msg);
        });
        return convos;
    }
}

const SmsWindow = GObject.registerClass({
    GTypeName: 'SmsWindow',
}, class SmsWindow extends Gtk.ApplicationWindow {
    _init(app) {
        super._init({
            application: app,
            title: 'Phone Hub SMS',
            default_width: 900,
            default_height: 700,
        });

        this.store = new MessageStore();
        this._selectedSender = null;

        this._setupLayout();
        this._updateConversations();

        // Use idle to start the first refresh after the window is ready
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            console.log('SMS Window: Initial refresh starting...');
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setupLayout() {
        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });
        this.set_child(mainBox);

        const header = new Gtk.HeaderBar();
        mainBox.append(header);

        const refreshBtn = new Gtk.Button({ icon_name: 'view-refresh-symbolic' });
        refreshBtn.connect('clicked', () => this._refresh());
        header.pack_start(refreshBtn);

        const paned = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            position: 280,
            vexpand: true,
        });
        mainBox.append(paned);

        // Sidebar
        const sidebarScrolled = new Gtk.ScrolledWindow({
            width_request: 280,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        this._convoList = new Gtk.ListBox();
        this._convoList.connect('row-selected', (lb, row) => {
            if (row && row.sender) {
                this._selectedSender = row.sender;
                this._updateMessages();
            }
        });
        sidebarScrolled.set_child(this._convoList);
        paned.set_start_child(sidebarScrolled);

        // Main Chat Area
        const chatBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
        });
        paned.set_end_child(chatBox);

        this._chatHeader = new Gtk.Label({
            label: 'Select a conversation',
            margin_top: 15,
            margin_bottom: 15,
            halign: Gtk.Align.CENTER,
            css_classes: ['chat-header'],
        });
        chatBox.append(this._chatHeader);

        const chatScrolled = new Gtk.ScrolledWindow({
            vexpand: true,
        });
        this._messageList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        this._messageList.add_css_class('chat-list');
        chatScrolled.set_child(this._messageList);
        chatBox.append(chatScrolled);

        // Message Entry Box
        const entryBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 20,
            margin_end: 20,
            margin_top: 10,
            margin_bottom: 20,
        });
        chatBox.append(entryBox);

        this._entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: 'Type a message...',
            css_classes: ['message-entry'],
        });
        this._entry.connect('activate', () => this._onSendClicked());
        entryBox.append(this._entry);

        const sendBtn = new Gtk.Button({
            icon_name: 'paper-plane-symbolic',
            css_classes: ['send-button'],
        });
        sendBtn.connect('clicked', () => this._onSendClicked());
        entryBox.append(sendBtn);

        const css = `
            .chat-list { background-color: #0b141a; }
            .chat-header { font-size: 14pt; font-weight: bold; color: #e9edef; }
            .message-bubble {
                padding: 10px 14px;
                border-radius: 10px;
                margin: 6px 20px;
                box-shadow: 0 1px 0.5px rgba(0,0,0,0.15);
                max-width: 500px;
            }
            .received { background-color: #202c33; }
            .sent { background-color: #005c4b; }
            .message-body { color: #e9edef; font-size: 11pt; line-height: 1.5; }
            .message-time { color: #8696a0; font-size: 8pt; margin-top: 4px; }
            .convo-row { padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.05); }
            .convo-row:hover { background-color: #202c33; }
            listbox > row:selected { background-color: #2a3942 !important; }
            .sidebar { background-color: #111b21; border-right: 1px solid rgba(255,255,255,0.1); }
            .message-entry { background-color: #2a3942; border: none; border-radius: 20px; color: white; padding: 10px 20px; }
            .send-button { background: none; border: none; color: #8696a0; }
            .send-button:hover { color: #00a884; }
        `;
        const provider = new Gtk.CssProvider();
        provider.load_from_data(css, -1);
        Gtk.StyleContext.add_provider_for_display(this.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        sidebarScrolled.add_css_class('sidebar');
    }

    _onSendClicked() {
        const text = this._entry.get_text();
        if (!text || !this._selectedSender) return;

        this.store.addMessages([{
            sender: 'Me',
            body: text,
            timestamp: Date.now(),
            remote_party: this._selectedSender
        }]);

        this._entry.set_text('');
        this._updateMessages();
        this._updateConversations();
    }

    _updateConversations() {
        let child = this._convoList.get_first_child();
        while (child) {
            this._convoList.remove(child);
            child = this._convoList.get_first_child();
        }

        const convos = this.store.getConversations();
        for (const [sender, messages] of convos) {
            const row = new Gtk.ListBoxRow();
            row.sender = sender;
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ['convo-row'] });
            box.append(new Gtk.Label({ label: `<b>${sender}</b>`, use_markup: true, xalign: 0 }));

            const lastMsg = messages[0];
            const prefix = lastMsg.sender === 'Me' ? 'You: ' : '';
            box.append(new Gtk.Label({
                label: prefix + (lastMsg.body.length > 35 ? lastMsg.body.substring(0, 35) + '...' : lastMsg.body),
                xalign: 0,
                opacity: 0.7,
                ellipsize: 3 // Pango.EllipsizeMode.END
            }));
            row.set_child(box);
            this._convoList.append(row);
        }
    }

    _updateMessages() {
        let child = this._messageList.get_first_child();
        while (child) {
            this._messageList.remove(child);
            child = this._messageList.get_first_child();
        }

        if (!this._selectedSender) return;
        this._chatHeader.set_markup(`<b>${this._selectedSender}</b>`);

        const allMessages = this.store.messages;
        const conversation = allMessages.filter(m =>
            m.sender === this._selectedSender ||
            (m.sender === 'Me' && m.remote_party === this._selectedSender)
        ).sort((a, b) => a.timestamp - b.timestamp);

        conversation.forEach(msg => {
            const isMe = msg.sender === 'Me';
            const row = new Gtk.ListBoxRow({ selectable: false, activatable: false });

            const outerBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
            const bubble = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                css_classes: ['message-bubble', isMe ? 'sent' : 'received'],
                halign: isMe ? Gtk.Align.END : Gtk.Align.START,
                hexpand: true
            });

            bubble.append(new Gtk.Label({
                label: msg.body,
                wrap: true,
                xalign: 0,
                selectable: true,
                css_classes: ['message-body']
            }));

            const date = new Date(msg.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            bubble.append(new Gtk.Label({
                label: timeStr,
                xalign: 1,
                css_classes: ['message-time']
            }));

            outerBox.append(bubble);
            row.set_child(outerBox);
            this._messageList.append(row);
        });

        // Scroll to bottom
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const scrolled = this._messageList.get_parent();
            if (scrolled) {
                const adj = scrolled.get_vadjustment();
                adj.set_value(adj.get_upper() - adj.get_page_size());
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        try {
            const newMessages = await this._fetchSMS();
            if (this.store.addMessages(newMessages)) {
                this._updateConversations();
                if (this._selectedSender) this._updateMessages();
            }
        } catch (e) {
            console.error(`Refresh error: ${e.message}`);
        }
    }

    async _fetchSMS() {
        return new Promise((resolve, reject) => {
            const session = new Soup.Session();
            const message = Soup.Message.new('GET', SMS_URL);
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (message.status_code !== 200) throw new Error(message.reason_phrase);
                    resolve(JSON.parse(new TextDecoder('utf-8').decode(bytes.toArray())));
                } catch (e) { reject(e); }
            });
        });
    }
});

const app = new Gtk.Application({
    application_id: 'org.gnome.PhoneHub.SmsWindow',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    console.log('SMS Window: App activated');
    let win = new SmsWindow(app);
    win.show();
    win.present();
});

console.log('SMS Window: Running app.run(null)...');
try {
    app.run(null);
} catch (e) {
    console.error('SMS Window: app.run error:', e);
}

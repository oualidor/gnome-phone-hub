#!/usr/bin/gjs
/**
 * contactsWindow.js – Standalone GJS script to browse phone contacts and start calls.
 *
 * This version is a pure UI picker:
 * 1. CLI args: --host <ip> --token <rest_token>
 */

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

try {
    let host = '127.0.0.1';
    let token = '';

    for (let i = 0; i < ARGV.length; i++) {
        if (ARGV[i] === '--host' && ARGV[i + 1]) host = ARGV[i + 1];
        if (ARGV[i] === '--token' && ARGV[i + 1]) token = ARGV[i + 1];
    }

    const app = new Gtk.Application({
        application_id: 'com.oualidkhial.phonehub.contacts.app' + Date.now(),
        flags: Gio.ApplicationFlags.FLAGS_NONE
    });

    const session = new Soup.Session();

    app.connect('activate', () => {
        const window = new Gtk.ApplicationWindow({
            application: app,
            title: `Contacts & Calling (${host})`,
            default_width: 450,
            default_height: 700,
        });

        const notebook = new Gtk.Notebook();
        window.set_child(notebook);

        // --- CONTACTS TAB ---
        const contactsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 16,
            margin_bottom: 16,
            margin_start: 16,
            margin_end: 16,
        });

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search contacts...',
            margin_bottom: 8,
        });
        contactsBox.append(searchEntry);

        const listStore = new Gio.ListStore({ item_type: GObject.TYPE_OBJECT });
        const ContactItem = GObject.registerClass({
            Properties: {
                'name': GObject.ParamSpec.string('name', 'Name', 'Contact Name', GObject.ParamFlags.READWRITE, ''),
                'number': GObject.ParamSpec.string('number', 'Number', 'Phone Number', GObject.ParamFlags.READWRITE, ''),
            }
        }, class ContactItem extends GObject.Object { });

        const filter = new Gtk.CustomFilter();
        filter.set_filter_func((item) => {
            const text = searchEntry.get_text().toLowerCase();
            if (!text) return true;
            return item.name.toLowerCase().includes(text) || item.number.includes(text);
        });

        const filterListModel = new Gtk.FilterListModel({
            model: listStore,
            filter: filter,
        });

        searchEntry.connect('search-changed', () => {
            filter.changed(Gtk.FilterChange.DIFFERENT);
        });

        const selectionModel = new Gtk.SingleSelection({ model: filterListModel });
        const listView = new Gtk.ListView({
            model: selectionModel,
            factory: new Gtk.SignalListItemFactory(),
        });

        listView.factory.connect('setup', (factory, listItem) => {
            const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, margin_top: 8, margin_bottom: 8 });

            const labelBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
            const nameLabel = new Gtk.Label({ halign: Gtk.Align.START, xalign: 0 });
            nameLabel.add_css_class('title-4');
            const numLabel = new Gtk.Label({ halign: Gtk.Align.START, xalign: 0, opacity: 0.7 });
            numLabel.add_css_class('caption');
            labelBox.append(nameLabel);
            labelBox.append(numLabel);
            box.append(labelBox);

            const callBtn = new Gtk.Button({ icon_name: 'call-start-symbolic' });
            callBtn.add_css_class('suggested-action');
            callBtn.add_css_class('circular');
            box.append(callBtn);

            listItem.set_child(box);
        });

        listView.factory.connect('bind', (factory, listItem) => {
            const contact = listItem.get_item();
            const box = listItem.get_child();
            const labelBox = box.get_first_child();
            const nameLabel = labelBox.get_first_child();
            const numLabel = nameLabel.get_next_sibling();
            const callBtn = box.get_last_child();

            nameLabel.set_text(contact.name);
            numLabel.set_text(contact.number);

            const callId = callBtn.connect('clicked', () => {
                startCall(contact.number);
            });
            // We need to store the connection to disconnect on unbind to avoid memory leaks or multiple calls
            listItem._callId = callId;
        });

        listView.factory.connect('unbind', (factory, listItem) => {
            const box = listItem.get_child();
            const callBtn = box.get_last_child();
            if (listItem._callId) {
                callBtn.disconnect(listItem._callId);
            }
        });

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            has_frame: true,
        });
        scrolled.set_child(listView);
        contactsBox.append(scrolled);

        notebook.append_page(contactsBox, new Gtk.Label({ label: 'Contacts' }));

        // --- DIALER TAB ---
        const dialerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 24,
            margin_top: 32,
            margin_bottom: 32,
            margin_start: 32,
            margin_end: 32,
        });

        const numberLabel = new Gtk.Label({
            label: '',
            halign: Gtk.Align.CENTER,
            justify: Gtk.Justification.CENTER,
            maxWidthChars: 15,
            wrap: true,
        });
        numberLabel.add_css_class('title-1');
        dialerBox.append(numberLabel);

        const grid = new Gtk.Grid({
            column_spacing: 12,
            row_spacing: 12,
            halign: Gtk.Align.CENTER,
        });

        const keys = [
            '1', '2', '3',
            '4', '5', '6',
            '7', '8', '9',
            '*', '0', '#'
        ];

        let row = 0;
        let col = 0;
        keys.forEach(key => {
            const btn = new Gtk.Button({ label: key });
            btn.set_size_request(70, 70);
            btn.add_css_class('circular');
            btn.connect('clicked', () => {
                numberLabel.set_text(numberLabel.get_text() + key);
            });
            grid.attach(btn, col, row, 1, 1);
            col++;
            if (col > 2) {
                col = 0;
                row++;
            }
        });

        // Backspace button
        const backBtn = new Gtk.Button({ icon_name: 'edit-clear-symbolic' });
        backBtn.set_size_request(70, 70);
        backBtn.add_css_class('circular');
        backBtn.connect('clicked', () => {
            let t = numberLabel.get_text();
            if (t.length > 0) numberLabel.set_text(t.substring(0, t.length - 1));
        });
        grid.attach(backBtn, 2, 4, 1, 1);

        dialerBox.append(grid);

        const dialBtn = new Gtk.Button({
            label: 'Call',
            icon_name: 'call-start-symbolic',
            halign: Gtk.Align.CENTER,
        });
        dialBtn.set_size_request(200, 60);
        dialBtn.add_css_class('suggested-action');
        dialBtn.add_css_class('pill');
        dialBtn.connect('clicked', () => {
            const num = numberLabel.get_text();
            if (num) startCall(num);
        });
        dialerBox.append(dialBtn);

        notebook.append_page(dialerBox, new Gtk.Label({ label: 'Dialer' }));

        window.present();

        // Load contacts
        fetchContacts(listStore, ContactItem);
    });

    function fetchContacts(store, ContactItem) {
        console.log(`Phone HUB: Fetching contacts from ${host}...`);
        const url = `http://${host}:8080/contacts?token=${token}`;
        const message = Soup.Message.new('GET', url);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                const decoder = new TextDecoder();
                const text = decoder.decode(bytes.toArray());
                const contacts = JSON.parse(text);

                // Gio.ListStore doesn't have a clear() until GLib 2.74, let's just remove all
                while (store.get_n_items() > 0) store.remove(0);

                contacts.forEach(c => {
                    store.append(new ContactItem({
                        name: c.name,
                        number: c.number
                    }));
                });
                console.log(`Phone HUB: Loaded ${contacts.length} contacts`);
            } catch (e) {
                console.error(`Phone HUB: Failed to fetch contacts: ${e.message}`);
            }
        });
    }

    function startCall(number) {
        console.log(`Phone HUB: Starting call to ${number} via ${host}...`);
        const url = `http://${host}:8080/call?token=${token}&number=${encodeURIComponent(number)}`;
        const message = Soup.Message.new('POST', url);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                session.send_and_read_finish(res);
                console.log(`Phone HUB: Call initiated to ${number}`);
            } catch (e) {
                console.error(`Phone HUB: Failed to start call: ${e.message}`);
            }
        });
    }

    app.run(null);
} catch (e) {
    console.error(`Phone HUB: Contacts Error: ${e.message}`);
    console.error(e.stack);
}

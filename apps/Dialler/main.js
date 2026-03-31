#!/usr/bin/gjs

import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

const session = new Soup.Session();


let host = '127.0.0.1';
let token = '';
let restToken = '';

for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === '--host' && ARGV[i + 1]) host = ARGV[i + 1];
    if (ARGV[i] === '--token' && ARGV[i + 1]) token = ARGV[i + 1];
    if (ARGV[i] === '--restToken' && ARGV[i + 1]) restToken = ARGV[i + 1];
}


const DIAL_KEYS = [
    { digit: '1', letters: '' },
    { digit: '2', letters: 'ABC' },
    { digit: '3', letters: 'DEF' },
    { digit: '4', letters: 'GHI' },
    { digit: '5', letters: 'JKL' },
    { digit: '6', letters: 'MNO' },
    { digit: '7', letters: 'PQRS' },
    { digit: '8', letters: 'TUV' },
    { digit: '9', letters: 'WXYZ' },
    { digit: '*', letters: '' },
    { digit: '0', letters: '+' },
    { digit: '#', letters: '' }
];

let dialedNumber = '';

const app = new Gtk.Application({
    application_id: 'com.phonehub.dialer',
});

app.connect('activate', () => {

    /* LOAD CSS */

    const USER_DATA_DIR = GLib.get_user_data_dir();
    const cssFile = Gio.File.new_for_path(USER_DATA_DIR + '/gnome-shell/extensions/phone-hub@oualidkhial/apps/Dialler/dialler.css');


    const provider = new Gtk.CssProvider();
    provider.load_from_file(cssFile);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    const win = new Gtk.ApplicationWindow({
        application: app,
        default_width: 420,
        default_height: 720,
        title: "Phone"
    });

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL
    });

    win.set_child(root);

    /* STACK */

    const stack = new Gtk.Stack({
        vexpand: true
    });

    root.append(stack);

    /* ---------------- KEYPAD PAGE ---------------- */

    const keypadPage = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 15,
        margin_top: 30
    });

    const numberLabel = new Gtk.Label({ label: '' });
    numberLabel.add_css_class("number-display");

    keypadPage.append(numberLabel);

    const grid = new Gtk.Grid({
        column_spacing: 25,
        row_spacing: 25,
        halign: Gtk.Align.CENTER
    });

    keypadPage.append(grid);

    DIAL_KEYS.forEach((key, i) => {

        const btn = new Gtk.Button();
        btn.add_css_class("dial-key");

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2
        });

        const digit = new Gtk.Label({ label: key.digit });
        digit.add_css_class("digit");

        box.append(digit);

        if (key.letters) {
            const letters = new Gtk.Label({ label: key.letters });
            letters.add_css_class("letters");
            box.append(letters);
        }

        btn.set_child(box);

        btn.connect("clicked", () => {
            dialedNumber += key.digit;
            numberLabel.set_label(dialedNumber);
        });

        grid.attach(btn, i % 3, Math.floor(i / 3), 1, 1);

    });

    // Actions Row



    const actionsRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 20,
        halign: Gtk.Align.CENTER,
        margin_top: 10
    });


    /* CALL BUTTON */
    const callBtn = new Gtk.Button();
    callBtn.add_css_class("call-button");
    callBtn.connect('clicked', () => makeCall(dialedNumber));

    callBtn.set_child(
        new Gtk.Image({ icon_name: "call-start-symbolic", pixel_size: 28 })
    );


    actionsRow.append(callBtn);


    /* BACKSPACE BUTTON */

    const backspaceBtn = new Gtk.Button();
    backspaceBtn.add_css_class("backspace-button");

    backspaceBtn.set_child(
        new Gtk.Image({
            icon_name: "edit-clear-symbolic", pixel_size: 28
        })
    );


    backspaceBtn.connect("clicked", () => {
        dialedNumber = dialedNumber.slice(0, -1);
        numberLabel.set_label(dialedNumber);
    });

    actionsRow.append(backspaceBtn);

    // keypadPage.append(callBtn);
    keypadPage.append(actionsRow);





    stack.add_named(keypadPage, "keypad");

    /* ---------------- RECENTS PAGE ---------------- */

    const recentsScroll = new Gtk.ScrolledWindow({
        vexpand: true,
        propagate_natural_height: true
    });

    const recentsContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 5,
        margin_start: 20,
        margin_end: 20,
        margin_top: 10
    });

    recentsScroll.set_child(recentsContainer);
    stack.add_named(recentsScroll, "recents");

    /* ---------------- CONTACTS PAGE ---------------- */
    const contactsPage = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL
    });

    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: "Search contacts...",
        hexpand: true
    });
    searchEntry.add_css_class("search-entry");
    contactsPage.append(searchEntry);

    const contactsScroll = new Gtk.ScrolledWindow({
        vexpand: true,
        propagate_natural_height: true
    });

    const contactsContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        margin_start: 20,
        margin_end: 20
    });

    contactsScroll.set_child(contactsContainer);
    contactsPage.append(contactsScroll);

    stack.add_named(contactsPage, "contacts");

    let allContacts = [];
    searchEntry.connect("search-changed", () => {
        const query = searchEntry.get_text().toLowerCase();
        renderContacts(contactsContainer, allContacts.filter(c =>
            c.name.toLowerCase().includes(query) || c.number.includes(query)
        ));
    });

    /* ---------------- NAVBAR ---------------- */

    const nav = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.CENTER,
        spacing: 60,
        margin_bottom: 10
    });

    nav.add_css_class("bottom-nav");

    root.append(nav);

    function navButton(icon, label, page) {

        const btn = new Gtk.Button();
        btn.add_css_class("nav-btn");

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2
        });

        const img = new Gtk.Image({ icon_name: icon });
        const txt = new Gtk.Label({ label });

        txt.add_css_class("nav-label");

        box.append(img);
        box.append(txt);

        btn.set_child(box);

        btn.connect("clicked", () => {
            stack.set_visible_child_name(page);
            btn.add_css_class('active')
            if (page === "recents") {
                loadCallLog(recentsContainer);
            } else if (page === "contacts") {
                fetchContacts(contactsContainer, (contacts) => {
                    allContacts = contacts;
                });
            }
        });

        nav.append(btn);
        return btn

    }

    const keyPadButton = navButton("view-grid-symbolic", "Keypad", "keypad");
    const recentButton = navButton("call-start-symbolic", "Recents", "recents");
    const contactsButton = navButton("avatar-default-symbolic", "Contacts", "contacts");

    contactsButton.connect('clicked', () => {
        contactsButton.add_css_class('active')
        keyPadButton.remove_css_class('active')
        recentButton.remove_css_class('active')
    })
    keyPadButton.connect('clicked', () => {
        keyPadButton.add_css_class('active')
        recentButton.remove_css_class('active')
        contactsButton.remove_css_class('active')
    })

    recentButton.connect('clicked', () => {
        recentButton.add_css_class('active')
        keyPadButton.remove_css_class('active')
        contactsButton.remove_css_class('active')
    })

    recentButton.add_css_class('active')
    stack.set_visible_child_name("recents");

    win.present();
    loadCallLog(recentsContainer);

});

app.run(null);






function showLoading(container) {
    // Clear current list
    let child = container.get_first_child();
    while (child) {
        container.remove(child);
        child = container.get_first_child();
    }

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        vexpand: true,
        spacing: 12,
        margin_top: 60
    });

    const spinner = new Gtk.Spinner({
        spinning: true,
        width_request: 32,
        height_request: 32
    });

    const label = new Gtk.Label({
        label: "Fetching data...",
        opacity: 0.7
    });

    box.append(spinner);
    box.append(label);
    container.append(box);
}

function showError(container, message) {
    // Clear current list
    let child = container.get_first_child();
    while (child) {
        container.remove(child);
        child = container.get_first_child();
    }

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        vexpand: true,
        spacing: 15,
        margin_top: 60
    });

    const icon = new Gtk.Image({
        icon_name: "dialog-error-symbolic",
        pixel_size: 48
    });
    icon.set_opacity(0.5);

    const label = new Gtk.Label({
        label: message || "Failed to connect to phone",
        wrap: true,
        justify: Gtk.Justification.CENTER,
        max_width_chars: 30
    });
    label.add_css_class("error-text");

    const retryBtn = new Gtk.Button({ label: "Try Again", margin_top: 10 });
    retryBtn.add_css_class("suggested-action");
    retryBtn.add_css_class("pill");
    
    // Determine which function to call based on the container
    retryBtn.connect("clicked", () => {
        if (container.get_name && container.get_name() === "contacts-container") {
            // This is a bit tricky since we don't have a clean way to know which one was called.
            // But we can check for specific markers or just pass a type.
            // For now, let's keep it simple.
        }
    });

    box.append(icon);
    box.append(label);
    // box.append(retryBtn);
    container.append(box);
}


function loadCallLog(container) {
    showLoading(container);
    const url = token ? `ws://${host}:8080/ws?token=${token}` : `ws://${host}:8080/ws`;
    const message = Soup.Message.new('GET', url);

    console.log(`Phone HUB: Connecting to WebSocket for call log...`);

    session.websocket_connect_async(message, null, null, null, null, (sess, res) => {
        try {
            const connection = sess.websocket_connect_finish(res);
            console.log(`Phone HUB: WebSocket connected for call log`);

            const requestId = `call_log_${Date.now()}`;

            connection.connect('message', (conn, type, data) => {
                if (type !== Soup.WebsocketDataType.TEXT) return;

                const text = new TextDecoder().decode(data.toArray());
                const msg = JSON.parse(text);

                if (msg.type === 'CALL_LOG' && msg.reqId === requestId) {
                    const calls = msg.calls;

                    // Clear current list
                    let child = container.get_first_child();
                    while (child) {
                        container.remove(child);
                        child = container.get_first_child();
                    }

                    // Time Logic
                    const now = new Date();
                    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                    const yesterdayStart = todayStart - (24 * 60 * 60 * 1000);

                    const groups = [
                        { title: "Today", filter: c => c.date >= todayStart },
                        { title: "Yesterday", filter: c => c.date >= yesterdayStart && c.date < todayStart },
                        { title: "Older", filter: c => c.date < yesterdayStart }
                    ];

                    groups.forEach(group => {
                        const groupCalls = calls.filter(group.filter);
                        if (groupCalls.length === 0) return;

                        const label = new Gtk.Label({
                            label: group.title,
                            halign: Gtk.Align.START,
                            margin_bottom: 8,
                            margin_top: 10
                        });
                        label.add_css_class("section-title");
                        container.append(label);

                        const card = new Gtk.Box({
                            orientation: Gtk.Orientation.VERTICAL,
                            spacing: 0
                        });
                        card.add_css_class("call-card");

                        groupCalls.forEach(entry => {
                            const row = new Gtk.Box({
                                orientation: Gtk.Orientation.HORIZONTAL,
                                spacing: 10
                            });
                            row.add_css_class('recent-row');

                            const textStack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });

                            const nameLabel = new Gtk.Label({
                                label: entry.name || entry.number,
                                halign: Gtk.Align.START,
                                ellipsize: 3
                            });

                            if (entry.type === 'missed') nameLabel.set_markup(`<span color="#e01b24">${entry.name || entry.number}</span>`);

                            const timeStr = new Date(entry.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            const subLabel = new Gtk.Label({
                                label: `${entry.type.toUpperCase()} • ${timeStr}`,
                                halign: Gtk.Align.START
                            });
                            subLabel.add_css_class("nav-label");

                            textStack.append(nameLabel);
                            textStack.append(subLabel);

                            const callBtn = new Gtk.Button({ icon_name: 'call-start-symbolic', valign: Gtk.Align.CENTER });
                            callBtn.add_css_class('nav-btn');
                            callBtn.connect('clicked', () => makeCall(entry.number));

                            row.append(textStack);
                            row.append(callBtn);
                            card.append(row);

                            if (entry !== groupCalls[groupCalls.length - 1]) {
                                card.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
                            }
                        });

                        container.append(card);
                    });

                    connection.close(Soup.WebsocketCloseCode.NORMAL, "Done");
                }
            });

            connection.send_text(JSON.stringify({
                type: 'GET_CALL_LOG',
                reqId: requestId
            }));

        } catch (e) {
            console.error("Call Log Error: " + e);
            showError(container, "Could not load call history. Is the phone connected?");
        }
    });
}


function fetchContacts(container, callback) {
    showLoading(container);
    const url = `http://${host}:8080/contacts?token=${restToken}`;
    const message = Soup.Message.new('GET', url);

    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
        try {
            const bytes = sess.send_and_read_finish(res);
            const decoder = new TextDecoder();
            const text = decoder.decode(bytes.toArray());
            const contacts = JSON.parse(text);

            if (callback) callback(contacts);
            renderContacts(container, contacts);
        } catch (e) {
            console.error("Phone HUB: Failed to fetch contacts: " + e.message);
            showError(container, "Could not load contacts. Is the phone connected?");
        }
    });
}

function renderContacts(container, contacts) {
    // Clear current list
    let child = container.get_first_child();
    while (child) {
        container.remove(child);
        child = container.get_first_child();
    }

    if (contacts.length === 0) {
        container.append(new Gtk.Label({
            label: "No contacts found",
            margin_top: 20,
            opacity: 0.5
        }));
        return;
    }

    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL
    });
    card.add_css_class("call-card");

    contacts.forEach((contact, i) => {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 15
        });
        row.add_css_class('contact-row');

        // Avatar / Icon
        const initial = contact.name ? contact.name.charAt(0).toUpperCase() : '#';
        const avatar = new Gtk.Label({ label: initial });
        avatar.add_css_class("contact-avatar");
        row.append(avatar);

        const textStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            valign: Gtk.Align.CENTER
        });

        const nameLabel = new Gtk.Label({
            label: contact.name || "Unknown",
            halign: Gtk.Align.START
        });
        nameLabel.add_css_class("contact-name");

        const numLabel = new Gtk.Label({
            label: contact.number,
            halign: Gtk.Align.START
        });
        numLabel.add_css_class("contact-number");

        textStack.append(nameLabel);
        textStack.append(numLabel);

        const callBtn = new Gtk.Button({
            icon_name: 'call-start-symbolic',
            valign: Gtk.Align.CENTER
        });
        callBtn.add_css_class('nav-btn');
        callBtn.connect('clicked', () => makeCall(contact.number));

        row.append(textStack);
        row.append(callBtn);
        card.append(row);

        if (i < contacts.length - 1) {
            card.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
        }
    });

    container.append(card);
}


function makeCall(number) {
    if (!number) return;
    const url = token ? `ws://${host}:8080/ws?token=${token}` : `ws://${host}:8080/ws`;
    const message = Soup.Message.new('GET', url);
    session.websocket_connect_async(message, null, null, null, null, (sess, res) => {
        try {
            const connection = sess.websocket_connect_finish(res);
            connection.send_text(JSON.stringify({
                type: 'DIAL',
                number: number,
                reqId: `dial_${Date.now()}`
            }));
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                connection.close(Soup.WebsocketCloseCode.NORMAL, "Done");
                return GLib.SOURCE_REMOVE;
            });
            console.log(`Phone HUB: Call initiated to ${number} via WebSocket`);
        } catch (e) {
            console.error(`Phone HUB: Failed to initiate call: ${e.message}`);
        }
    });
}
#!/usr/bin/gjs
/**
 * appLauncherWindow.js – Standalone GJS script that shows a searchable list of
 * installed Android apps and lets the user pick one to launch on a virtual display.
 *
 * This version is a pure UI picker:
 * 1. CLI args: --host <ip> --apps '<json_array_of_apps>'
 * 2. When 'Launch' is clicked, logs 'SELECTED_APP:{"package":"...","width":...,"height":...}' to stdout and exits.
 */

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

try {
    console.log('Phone HUB: Launcher script started');

    // --- ARGS ---
    let appsJson = '[]';
    let host = '127.0.0.1';
    let scrcpyPath = '/usr/bin/scrcpy';

    for (let i = 0; i < ARGV.length; i++) {
        if (ARGV[i] === '--apps' && ARGV[i + 1]) appsJson = ARGV[i + 1];
        if (ARGV[i] === '--host' && ARGV[i + 1]) host = ARGV[i + 1];
        if (ARGV[i] === '--scrcpy' && ARGV[i + 1]) scrcpyPath = ARGV[i + 1];
    }

    console.log(`Phone HUB: Parsing ${appsJson.length} bytes of app data`);
    const ALL_APPS = JSON.parse(appsJson);
    console.log(`Phone HUB: Parsed ${ALL_APPS.length} apps`);

    // UI setup - Gtk.Application handles init normally
    // Gtk.init(); 

    const app = new Gtk.Application({
        application_id: 'com.oualidkhial.phonehub.launcher.' + Date.now(), // Unique ID for testing
        flags: Gio.ApplicationFlags.FLAGS_NONE
    });

    app.connect('activate', () => {
        console.log('Phone HUB: Application activated');
        try {
            const window = new Gtk.ApplicationWindow({
                application: app,
                title: `Launch App on PC (${host})`,
                default_width: 500,
                default_height: 600,
            });

            const mainBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 16,
                margin_bottom: 16,
                margin_start: 16,
                margin_end: 16,
            });
            window.set_child(mainBox);

            // Header
            const titleLabel = new Gtk.Label({
                label: 'Select Android App to Stream',
                halign: Gtk.Align.START,
            });
            titleLabel.add_css_class('title-2'); // GTK4 styling
            mainBox.append(titleLabel);

            // Search bar
            const searchEntry = new Gtk.SearchEntry({
                placeholder_text: 'Search apps...',
                margin_bottom: 8,
            });
            mainBox.append(searchEntry);

            // List and Model
            const listStore = new Gio.ListStore({ item_type: GObject.TYPE_OBJECT });

            // Custom object to hold app data
            const AppItem = GObject.registerClass({
                Properties: {
                    'name': GObject.ParamSpec.string('name', 'Name', 'App Label', GObject.ParamFlags.READWRITE, ''),
                    'package': GObject.ParamSpec.string('package', 'Package', 'Package ID', GObject.ParamFlags.READWRITE, ''),
                }
            }, class AppItem extends GObject.Object { });

            ALL_APPS.forEach(a => {
                listStore.append(new AppItem({ name: a.name, package: a.package }));
            });

            const filter = new Gtk.CustomFilter();
            filter.set_filter_func((item) => {
                const text = searchEntry.get_text().toLowerCase();
                if (!text) return true;
                return item.name.toLowerCase().includes(text) || item.package.toLowerCase().includes(text);
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
                const label = new Gtk.Label({ halign: Gtk.Align.START, xalign: 0 });
                box.append(label);
                listItem.set_child(box);
            });

            listView.factory.connect('bind', (factory, listItem) => {
                const appItem = listItem.get_item();
                const box = listItem.get_child();
                const label = box.get_first_child();
                label.set_markup(`<b>${appItem.name}</b>\n<small>${appItem.package}</small>`);
            });

            const scrolled = new Gtk.ScrolledWindow({
                vexpand: true,
                propagate_natural_height: true,
                min_content_height: 350,
                has_frame: true,
            });
            scrolled.set_child(listView);
            mainBox.append(scrolled);

            // Resolution selection
            const resBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            resBox.append(new Gtk.Label({ label: 'Display Resolution:' }));

            const widthEntry = new Gtk.Entry({ text: '1080', max_width_chars: 5 });
            const heightEntry = new Gtk.Entry({ text: '1920', max_width_chars: 5 });
            resBox.append(widthEntry);
            resBox.append(new Gtk.Label({ label: 'x' }));
            resBox.append(heightEntry);
            mainBox.append(resBox);

            // Controls
            const btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.END });

            const cancelBtn = new Gtk.Button({ label: 'Cancel' });
            cancelBtn.connect('clicked', () => app.quit());
            btnBox.append(cancelBtn);

            const launchBtn = new Gtk.Button({ label: 'Launch on PC' });
            launchBtn.add_css_class('suggested-action');

            launchBtn.connect('clicked', () => {
                const selected = selectionModel.get_selected_item();
                if (!selected) {
                    console.log('No app selected.');
                    return;
                }

                const width = parseInt(widthEntry.get_text()) || 1080;
                const height = parseInt(heightEntry.get_text()) || 1920;
                const packageName = selected.package;

                try {
                    const scrcpyArgs = [
                        scrcpyPath,
                        '-s', host,
                        // `--new-display=${width}x${height}`,
                        `--start-app=${packageName}`
                    ];
                    console.log(`Phone HUB Launcher: Starting scrcpy: ${scrcpyArgs.join(' ')}`);
                    Gio.Subprocess.new(scrcpyArgs, Gio.SubprocessFlags.NONE);
                } catch (e) {
                    console.error(`Phone HUB Launcher: Failed to start scrcpy: ${e.message}`);
                }

                // Close picker immediately after launch attempt
                app.quit();
            });

            btnBox.append(launchBtn);
            mainBox.append(btnBox);

            window.present();
        } catch (e) {
            console.error(`Phone HUB: Error in activate: ${e.message}`);
            console.error(e.stack);
        }
    });

    console.log('Phone HUB: Running application');
    app.run(null);
} catch (e) {
    console.error(`Phone HUB: Global Launcher Error: ${e.message}`);
    console.error(e.stack);
}

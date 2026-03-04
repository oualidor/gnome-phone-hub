import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import * as Sms from './sms.js';

export const SmsDialog = GObject.registerClass({
    GTypeName: 'SmsDialog',
}, class SmsDialog extends ModalDialog.ModalDialog {

    _init() {
        super._init({
            styleClass: 'sms-dialog',
            destroyOnClose: true,
        });

        this._buildLayout();
        this._refresh().catch(e => {
            console.error(`SmsDialog Init Error: ${e.message}`);
        });
    }

    _buildLayout() {
        let title = new St.Label({
            text: 'Recent SMS Messages',
            style_class: 'sms-dialog-title',
        });
        this.contentLayout.add_child(title);

        this._scrollView = new St.ScrollView({
            style_class: 'sms-dialog-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this.contentLayout.add_child(this._scrollView);

        this._listContent = new St.BoxLayout({
            vertical: true,
            style_class: 'sms-dialog-list',
        });
        this._scrollView.add_child(this._listContent);

        this.setButtons([
            {
                label: 'Refresh',
                action: () => this._refresh(),
                key: Clutter.KEY_r,
            },
            {
                label: 'Close',
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
        ]);
    }

    async _refresh() {
        this._listContent.remove_all_children();
        this._listContent.add_child(new St.Label({ text: 'Loading...' }));

        try {
            const messages = await Sms.fetchSMS();
            this._listContent.remove_all_children();

            if (!messages || messages.length === 0) {
                this._listContent.add_child(new St.Label({ text: 'No messages found.' }));
            } else {
                messages.forEach(msg => {
                    let btn = new St.Button({
                        style_class: 'sms-dialog-item-button',
                        can_focus: true,
                        reactive: true,
                    });

                    let msgBox = new St.BoxLayout({
                        vertical: true,
                        style_class: 'sms-dialog-item',
                    });

                    let sender = new St.Label({
                        text: msg.sender || msg.sende || 'Unknown',
                        style_class: 'sms-dialog-sender',
                    });
                    msgBox.add_child(sender);

                    let body = new St.Label({
                        text: msg.body || '',
                        style_class: 'sms-dialog-body',
                    });
                    body.clutter_text.line_wrap = true;
                    msgBox.add_child(body);

                    btn.set_child(msgBox);

                    btn.connect('clicked', () => {
                        // Toggle a "selected" style or perform an action
                        if (btn.has_style_class_name('selected')) {
                            btn.remove_style_class_name('selected');
                        } else {
                            // Unselect others if single selection is desired
                            this._listContent.get_children().forEach(c => c.remove_style_class_name('selected'));
                            btn.add_style_class_name('selected');
                        }
                    });

                    this._listContent.add_child(btn);
                });
            }
        } catch (e) {
            this._listContent.remove_all_children();
            this._listContent.add_child(new St.Label({ text: `Error: ${e.message}` }));
        }
    }
});

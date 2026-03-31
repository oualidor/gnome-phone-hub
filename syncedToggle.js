import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import St from 'gi://St';

/**
 * Manages a single logical toggle state that can be represented by multiple PopupSwitchMenuItems
 * across different menus (e.g., main menu and top bar menu), ensuring they stay perfectly synced.
 */
export class SyncedToggle {
    constructor(label, iconName, initialState, onToggleCallback) {
        this.label = label;
        this.iconName = iconName;
        this.state = initialState;
        this.onToggleCallback = onToggleCallback;
        
        this.instances = [];
        this.sensitive = true;
        this.labelSuffix = '';
    }

    /**
     * Set whether the toggle is interactive and optionally append a reason to the label.
     */
    setSensitive(sensitive, reason = '') {
        this.sensitive = sensitive;
        this.labelSuffix = reason;
        
        const fullLabel = this.label + (this.labelSuffix ? ` (${this.labelSuffix})` : '');
        for (let toggle of this.instances) {
            toggle.sensitive = sensitive;
            toggle.label.text = fullLabel;
        }
    }

    /**
     * Programmatically update the state of all toggle instances.
     * @param {boolean} state - The new state
     * @param {boolean} triggerCallback - Whether to trigger the onToggleCallback (default: true)
     */
    setState(state, triggerCallback = true) {
        if (this.state === state) return;
        this.state = state;
        
        for (let toggle of this.instances) {
            // Prevent the 'toggled' connected signal from firing the callback again
            toggle._ignoreToggle = true; 
            toggle.setToggleState(state);
            toggle._ignoreToggle = false;
        }

        if (triggerCallback && this.onToggleCallback) {
            this.onToggleCallback(state);
        }
    }

    /**
     * Create and return a new PopupSwitchMenuItem tied to this synced state.
     */
    createMenuItem() {
        const fullLabel = this.label + (this.labelSuffix ? ` (${this.labelSuffix})` : '');
        let toggle = new PopupMenu.PopupSwitchMenuItem(fullLabel, this.state);
        
        if (this.iconName) {
            toggle.insert_child_at_index(new St.Icon({
                icon_name: this.iconName,
                style_class: 'popup-menu-icon',
            }), 0);
        }
        
        toggle.sensitive = this.sensitive;

        // Listen for user interaction on this specific cloned toggle
        toggle.connect('toggled', (item, state) => {
            if (toggle._ignoreToggle) return;
            
            // Update the logical state, but don't re-trigger the callback for this logical update
            this.state = state;
            
            // Sync all OTHER instances
            for (let otherToggle of this.instances) {
                if (otherToggle !== toggle) {
                    otherToggle._ignoreToggle = true;
                    otherToggle.setToggleState(state);
                    otherToggle._ignoreToggle = false;
                }
            }

            // Trigger the main business logic callback
            if (this.onToggleCallback) {
                this.onToggleCallback(state);
            }
        });

        this.instances.push(toggle);
        
        // Clean up references when the menu item is destroyed
        toggle.connect('destroy', () => {
            this.instances = this.instances.filter(i => i !== toggle);
        });

        return toggle;
    }
}

/**
 * Manages a single logical action item that can be represented by multiple PopupMenuItems
 * across different menus, ensuring their labels, icons, and sensitivity stay perfectly synced.
 */
export class SyncedAction {
    constructor(label, iconName, onActivateCallback) {
        this.label = label;
        this.iconName = iconName;
        this.onActivateCallback = onActivateCallback;
        
        this.instances = [];
        this.sensitive = true;
    }

    setSensitive(sensitive) {
        this.sensitive = sensitive;
        for (let item of this.instances) {
            item.sensitive = sensitive;
        }
    }

    setLabelAndIcon(label, iconName) {
        this.label = label;
        this.iconName = iconName;
        for (let item of this.instances) {
            item.label.text = label;
            if (item._actionIcon) {
                item._actionIcon.icon_name = iconName;
            }
        }
    }

    createMenuItem() {
        let item = new PopupMenu.PopupMenuItem(this.label);
        
        let icon = new St.Icon({
            icon_name: this.iconName,
            style_class: 'popup-menu-icon',
        });
        item.insert_child_at_index(icon, 0);
        item._actionIcon = icon; // Store reference to update later
        
        item.sensitive = this.sensitive;

        item.connect('activate', () => {
            if (this.onActivateCallback) {
                this.onActivateCallback();
            }
        });

        this.instances.push(item);
        
        item.connect('destroy', () => {
            this.instances = this.instances.filter(i => i !== item);
        });

        return item;
    }
}

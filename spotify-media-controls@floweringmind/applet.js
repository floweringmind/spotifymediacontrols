const Applet = imports.ui.applet;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const PopupMenu = imports.ui.popupMenu;
const Clutter = imports.gi.Clutter;

class SpotifyMediaControlsApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        
        this.set_applet_icon_symbolic_name('spotify-symbolic');
        
        // Initialize state
        this._timeout = null;
        this._processes = new Set();
        this._updatePending = false;
        this._lastUpdate = 0;
        this._updateInterval = 2000; // 2 seconds
        this._menuUpdateTimeout = null;
        
        // Create popup menu
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        
        // Make the applet reactive
        this.actor.reactive = true;
        this.actor.connect('enter-event', () => {
            if (this.menu) {
                this.menu.open();
            }
        });

        // Connect to global stage for click-outside detection
        this._stage = global.stage;
        this._stageButtonPressId = this._stage.connect('button-press-event', this._onStageButtonPress.bind(this));
        
        // Start updating the menu
        this.update_info();
    }

    _onStageButtonPress(actor, event) {
        try {
            if (this.menu && this.menu.isOpen) {
                // Check if click is outside both the applet and menu
                let [clickX, clickY] = event.get_coords();
                let appletRect = this.actor.get_allocation_box();
                let menuRect = this.menu.actor.get_allocation_box();
                
                if (!this._isPointInRect(clickX, clickY, appletRect) && 
                    !this._isPointInRect(clickX, clickY, menuRect)) {
                    this.menu.close();
                }
            }
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error handling stage click: ${e.message}`);
        }
    }

    _isPointInRect(x, y, rect) {
        return x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
    }

    _runCommand(command, callback) {
        try {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            
            let process = launcher.spawnv(['/bin/sh', '-c', command]);
            this._processes.add(process);

            // Set up timeout
            let timeoutId = Mainloop.timeout_add_seconds(1, () => {
                try {
                    process.force_exit();
                    this._processes.delete(process);
                    callback([false, null]);
                } catch (e) {
                    global.log(`[spotify-media-controls@floweringmind]: Error killing process: ${e.message}`);
                }
                return false;
            });

            process.communicate_utf8_async(null, null, (process, result) => {
                try {
                    Mainloop.source_remove(timeoutId);
                    let [success, stdout, stderr] = process.communicate_utf8_finish(result);
                    
                    if (success) {
                        callback([true, stdout]);
                    } else {
                        global.log(`[spotify-media-controls@floweringmind]: Command failed: ${stderr}`);
                        callback([false, null]);
                    }
                } catch (e) {
                    global.log(`[spotify-media-controls@floweringmind]: Error getting command result: ${e.message}`);
                    callback([false, null]);
                } finally {
                    this._processes.delete(process);
                }
            });
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error running command: ${e.message}`);
            callback([false, null]);
        }
    }

    _safeUpdateMenu(title, artist, artUrl) {
        try {
            if (!this.menu) return;

            // Clear any pending menu updates
            if (this._menuUpdateTimeout) {
                Mainloop.source_remove(this._menuUpdateTimeout);
            }

            // Schedule menu update in the main thread
            this._menuUpdateTimeout = Mainloop.timeout_add(100, () => {
                this._updateMenu(title, artist, artUrl);
                return false;
            });
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error scheduling menu update: ${e.message}`);
        }
    }

    _cleanupProcesses() {
        try {
            for (let process of this._processes) {
                try {
                    process.force_exit();
                } catch (e) {
                    global.log(`[spotify-media-controls@floweringmind]: Error killing process: ${e.message}`);
                }
            }
            this._processes.clear();
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error cleaning up processes: ${e.message}`);
        }
    }

    update_info() {
        try {
            // Prevent multiple simultaneous updates
            if (this._updatePending) return;
            
            // Check update interval
            let now = Date.now();
            if (now - this._lastUpdate < this._updateInterval) {
                return;
            }
            
            this._updatePending = true;
            this._lastUpdate = now;

            // First check if Spotify is running
            this._runCommand('pgrep spotify', ([spotify_running, pid]) => {
                if (!spotify_running || !pid) {
                    this._safeUpdateMenu(_('Spotify not running'));
                    this._updatePending = false;
                    return;
                }

                // Get song info
                this._runCommand('playerctl -p spotify metadata title', ([title_success, title_output]) => {
                    this._runCommand('playerctl -p spotify metadata artist', ([artist_success, artist_output]) => {
                        this._runCommand('playerctl -p spotify metadata mpris:artUrl', ([art_success, art_output]) => {
                            if (title_success && title_output) {
                                let title = title_output.toString().trim();
                                let artist = artist_success ? artist_output.toString().trim() : '';
                                let artUrl = art_success ? art_output.toString().trim() : '';
                                
                                if (title) {
                                    this._safeUpdateMenu(title, artist, artUrl);
                                } else {
                                    this._safeUpdateMenu(_('No song playing'));
                                }
                            } else {
                                this._safeUpdateMenu(_('Spotify not running'));
                            }
                            this._updatePending = false;
                        });
                    });
                });
            });
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error: ${e.message}`);
            this._safeUpdateMenu(_('Spotify not running'));
            this._updatePending = false;
        }
        
        // Schedule next update
        if (this._timeout) {
            Mainloop.source_remove(this._timeout);
        }
        this._timeout = Mainloop.timeout_add_seconds(2, () => {
            this.update_info();
            return true;
        });
    }

    _updateMenu(title, artist, artUrl) {
        try {
            if (!this.menu) return;

            this.menu.removeAll();

            if (typeof title === 'string' && !artist && !artUrl) {
                // Simple message case
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(title));
                return;
            }

            // Create box for song info
            let menuBox = new St.BoxLayout({
                vertical: true,
                style_class: 'spotify-menu-box'
            });

            // Add album art if available
            if (artUrl) {
                try {
                    let menuIcon = new St.Icon({
                        gicon: Gio.icon_new_for_string(artUrl),
                        style_class: 'spotify-menu-image'
                    });
                    menuBox.add(menuIcon);
                } catch (e) {
                    global.log(`[spotify-media-controls@floweringmind]: Error loading album art: ${e.message}`);
                }
            }

            // Add title
            let menuTitle = new St.Label({
                text: title,
                style_class: 'spotify-menu-title'
            });
            menuBox.add(menuTitle);

            // Add artist if available
            if (artist) {
                let menuArtist = new St.Label({
                    text: artist,
                    style_class: 'spotify-menu-artist'
                });
                menuBox.add(menuArtist);
            }

            // Add the box to the menu
            let menuItem = new PopupMenu.PopupBaseMenuItem();
            menuItem.addActor(menuBox);
            this.menu.addMenuItem(menuItem);

            // Add controls with icons
            let playPauseItem = new PopupMenu.PopupMenuItem('▶ ' + _('Play/Pause'));
            playPauseItem.actor.reactive = true;
            playPauseItem.actor.connect('button-press-event', () => {
                this._runCommand('playerctl -p spotify play-pause', () => {});
                return true;
            });
            this.menu.addMenuItem(playPauseItem);

            let nextItem = new PopupMenu.PopupMenuItem('⏭ ' + _('Next'));
            nextItem.actor.reactive = true;
            nextItem.actor.connect('button-press-event', () => {
                this._runCommand('playerctl -p spotify next', () => {});
                return true;
            });
            this.menu.addMenuItem(nextItem);

            let prevItem = new PopupMenu.PopupMenuItem('⏮ ' + _('Previous'));
            prevItem.actor.reactive = true;
            prevItem.actor.connect('button-press-event', () => {
                this._runCommand('playerctl -p spotify previous', () => {});
                return true;
            });
            this.menu.addMenuItem(prevItem);
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error updating menu: ${e.message}`);
            this.menu.removeAll();
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Error updating menu')));
        }
    }

    on_applet_clicked(event) {
        try {
            if (this.menu) {
                this.menu.toggle();
            }
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error toggling menu: ${e.message}`);
        }
    }

    on_applet_removed_from_panel() {
        try {
            // Clean up timeouts when applet is removed
            if (this._timeout) {
                Mainloop.source_remove(this._timeout);
                this._timeout = null;
            }
            if (this._menuUpdateTimeout) {
                Mainloop.source_remove(this._menuUpdateTimeout);
                this._menuUpdateTimeout = null;
            }
            
            // Clean up all running processes
            this._cleanupProcesses();
            
            // Disconnect from stage
            if (this._stage && this._stageButtonPressId) {
                this._stage.disconnect(this._stageButtonPressId);
            }
        } catch (e) {
            global.log(`[spotify-media-controls@floweringmind]: Error cleaning up: ${e.message}`);
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new SpotifyMediaControlsApplet(metadata, orientation, panel_height, instance_id);
} 
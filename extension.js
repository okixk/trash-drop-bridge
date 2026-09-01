import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LOG_PREFIX = '[TrashDropBridge]';
const TRASH_APP_ID = 'location:trash://';
const META_SELECTION_DND = 2;
const DROP_RELEASE_DELAY_MS = 40;
const FEEDBACK_SUPPRESS_MS = 420;
const MAX_CAPTURE_BYTES = 1024 * 1024;

function logInfo(message) {
    console.log(`${LOG_PREFIX} ${message}`);
}

function safeChildren(actor) {
    try {
        return actor?.get_children?.() ?? [];
    } catch {
        return [];
    }
}

function actorRect(actor) {
    try {
        if (!actor || actor.is_destroyed?.())
            return null;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        if (![x, y, w, h].every(Number.isFinite) || w < 8 || h < 8)
            return null;
        return {x, y, w, h};
    } catch {
        return null;
    }
}

function contains(rect, x, y, margin = 0) {
    return x >= rect.x - margin && x < rect.x + rect.w + margin &&
        y >= rect.y - margin && y < rect.y + rect.h + margin;
}

function getPossibleApps(actor) {
    const delegate = actor?._delegate;
    return [
        actor?.app,
        delegate?.app,
        actor?._app,
        delegate?._app,
    ].filter(Boolean);
}

function isTrashActor(actor) {
    for (const app of getPossibleApps(actor)) {
        try {
            const id = app.get_id?.();
            if (id === TRASH_APP_ID || id?.startsWith('location:trash:'))
                return true;
        } catch {
            // Actor can disappear while Ubuntu Dock rebuilds itself.
        }
    }
    return false;
}

function parseDraggedUris(data, mimeType) {
    const uris = [];

    for (let line of data.split(/\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#'))
            continue;

        // x-special/gnome-icon-list stores geometry after a CR.
        if (mimeType === 'x-special/gnome-icon-list')
            line = line.split('\r', 1)[0].trim();
        else
            line = line.replace(/\r$/, '').trim();

        if (line.startsWith('/')) {
            uris.push(Gio.File.new_for_path(line).get_uri());
            continue;
        }

        // A trash drop should only operate on GIO file-like URIs. Ignore web,
        // data and already-trashed URIs even if another source happens to offer
        // them as text/uri-list.
        try {
            const scheme = GLib.uri_parse_scheme(line);
            if (!scheme || ['http', 'https', 'data', 'trash'].includes(scheme.toLowerCase()))
                continue;
            uris.push(Gio.File.new_for_uri(line).get_uri());
        } catch {
            // Ignore malformed lines from a drag source.
        }
    }

    return [...new Set(uris)];
}

export default class TrashDropBridgeExtension extends Extension {
    enable() {
        this._dnd = global.backend.get_dnd();
        this._trashActors = [];
        this._dragSerial = 0;
        this._captureStarted = false;
        this._capturedUris = null;
        this._captureError = null;
        this._hoveredTrash = false;
        this._hoveredActor = null;
        this._dropRequested = false;
        this._leaveTimeoutId = 0;
        this._feedbackRestoreId = 0;
        this._feedbackGroup = global.compositor.get_feedback_group();
        this._settings = this.getSettings();

        this._highlight = new St.Widget({
            reactive: false,
            visible: false,
            style: 'background-color: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.35); border-radius: 12px;',
        });
        Main.uiGroup.add_child(this._highlight);

        this._dndEnterId = this._dnd.connect('dnd-enter', () => this._onDndEnter());
        this._dndPositionId = this._dnd.connect(
            'dnd-position-change',
            (_dnd, x, y) => this._onDndPosition(x, y)
        );
        this._dndLeaveId = this._dnd.connect('dnd-leave', () => this._onDndLeave());

        this._refreshTrashActors();
        logInfo(`Enabled v2; found ${this._trashActors.length} trash actor(s).`);
    }

    disable() {
        if (this._leaveTimeoutId) {
            GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = 0;
        }

        this._restoreFeedbackGroup();

        if (this._dnd) {
            for (const id of [this._dndEnterId, this._dndPositionId, this._dndLeaveId]) {
                if (id)
                    this._dnd.disconnect(id);
            }
        }

        this._hideHighlight();
        this._highlight?.destroy();
        this._highlight = null;
        this._trashActors = [];
        this._feedbackGroup = null;
        this._settings = null;
        this._dnd = null;
        this._dragSerial++;
        logInfo('Disabled.');
    }

    _onDndEnter() {
        this._restoreFeedbackGroup();
        this._dragSerial++;
        this._captureStarted = false;
        this._capturedUris = null;
        this._captureError = null;
        this._hoveredTrash = false;
        this._hoveredActor = null;
        this._dropRequested = false;
        this._hideHighlight();

        if (this._leaveTimeoutId) {
            GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = 0;
        }

        this._refreshTrashActors();
        logInfo(`DND enter; found ${this._trashActors.length} trash actor(s).`);
        this._tryCaptureDragUris(this._dragSerial);
    }

    _onDndPosition(x, y) {
        if (!this._captureStarted)
            this._tryCaptureDragUris(this._dragSerial);

        let target = this._findTrashAt(x, y);
        if (!target) {
            // Ubuntu Dock may auto-reveal or rebuild after the drag begins.
            this._refreshTrashActors();
            target = this._findTrashAt(x, y);
        }

        const wasHovered = this._hoveredTrash;
        this._hoveredTrash = !!target;
        this._hoveredActor = target?.actor ?? null;

        if (target)
            this._showHighlight(target.rect);
        else
            this._hideHighlight();

        if (!wasHovered && this._hoveredTrash)
            logInfo('Pointer entered Trash drop zone.');
        else if (wasHovered && !this._hoveredTrash)
            logInfo('Pointer left Trash drop zone.');
    }

    _onDndLeave() {
        const serial = this._dragSerial;
        const wasOverTrash = this._hoveredTrash;
        this._hideHighlight();

        // Mutter/Nautilus still considers the Shell area a rejected external
        // Wayland target because Meta.Dnd exposes no accept/finish API to
        // extensions. The file operation below succeeds independently, so hide
        // Mutter's transient drag-feedback layer just long enough to suppress
        // the misleading snap-back animation after a Trash drop.
        if (wasOverTrash && this._settings?.get_boolean('suppress-snapback'))
            this._suppressFeedbackTemporarily();

        // Mutter emits dnd-leave for both a real button release and a cancelled
        // drag. Check the physical button state a moment later: on a normal
        // drop button 1 is up; after Escape it is still held down.
        if (this._leaveTimeoutId)
            GLib.source_remove(this._leaveTimeoutId);

        this._leaveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            DROP_RELEASE_DELAY_MS,
            () => {
                this._leaveTimeoutId = 0;
                if (serial !== this._dragSerial)
                    return GLib.SOURCE_REMOVE;

                const [, , modifiers] = global.get_pointer();
                const buttonStillDown = !!(
                    modifiers & Clutter.ModifierType.BUTTON1_MASK
                );

                if (wasOverTrash && !buttonStillDown) {
                    this._dropRequested = true;
                    logInfo('Mouse released over Trash; committing drop.');
                    this._commitDropIfReady(serial);
                } else if (wasOverTrash) {
                    logInfo('Drag ended over Trash but button is still down; treating as cancel.');
                }

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _tryCaptureDragUris(serial) {
        if (this._captureStarted || serial !== this._dragSerial)
            return;

        let selection;
        let mimeTypes;
        try {
            selection = global.display.get_selection();
            mimeTypes = selection.get_mimetypes(META_SELECTION_DND) ?? [];
        } catch (error) {
            this._captureError = error.message;
            return;
        }

        const preferred = [
            'text/uri-list',
            'x-special/gnome-icon-list',
            'text/plain;charset=utf-8',
            'text/plain',
        ];
        const mimeType = preferred.find(type => mimeTypes.includes(type));
        if (!mimeType)
            return;

        this._captureStarted = true;
        logInfo(`Capturing DND selection as ${mimeType}; offered: ${mimeTypes.join(', ')}`);

        const output = Gio.MemoryOutputStream.new_resizable();
        try {
            selection.transfer_async(
                META_SELECTION_DND,
                mimeType,
                MAX_CAPTURE_BYTES,
                output,
                null,
                (source, result) => {
                    if (serial !== this._dragSerial)
                        return;

                    try {
                        source.transfer_finish(result);
                        output.close(null);
                        const bytes = output.steal_as_bytes();
                        const data = new TextDecoder().decode(bytes.get_data());
                        this._capturedUris = parseDraggedUris(data, mimeType);
                        logInfo(`Captured ${this._capturedUris.length} dragged URI(s).`);
                    } catch (error) {
                        this._captureError = error.message;
                        this._capturedUris = [];
                        console.error(`${LOG_PREFIX} DND selection transfer failed: ${error.message}`);
                    }

                    this._commitDropIfReady(serial);
                }
            );
        } catch (error) {
            this._captureError = error.message;
            this._capturedUris = [];
            console.error(`${LOG_PREFIX} Could not start DND selection transfer: ${error.message}`);
            this._commitDropIfReady(serial);
        }
    }

    _commitDropIfReady(serial) {
        if (serial !== this._dragSerial || !this._dropRequested)
            return;
        if (this._capturedUris === null)
            return; // Selection transfer is still in flight.

        const uris = this._capturedUris;
        this._dropRequested = false;

        if (uris.length === 0) {
            console.error(`${LOG_PREFIX} Drop requested but no file URIs were captured${this._captureError ? `: ${this._captureError}` : '.'}`);
            return;
        }

        let succeeded = 0;
        const failures = [];
        for (const uri of uris) {
            try {
                const file = Gio.File.new_for_uri(uri);
                if (file.trash(null)) {
                    succeeded++;
                    logInfo(`Trashed: ${uri}`);
                } else {
                    failures.push(`${uri}: Gio.File.trash() returned false`);
                }
            } catch (error) {
                failures.push(`${uri}: ${error.message}`);
            }
        }

        for (const failure of failures)
            console.error(`${LOG_PREFIX} Failed: ${failure}`);

        if (succeeded > 0 && this._settings?.get_boolean('show-notifications')) {
            const noun = succeeded === 1 ? 'item' : 'items';
            Main.notify('Moved to Trash', `${succeeded} ${noun}`);
        }

        logInfo(`Drop complete: ${succeeded}/${uris.length} item(s) moved to trash.`);
    }


    _suppressFeedbackTemporarily() {
        if (!this._feedbackGroup)
            return;

        if (this._feedbackRestoreId) {
            GLib.source_remove(this._feedbackRestoreId);
            this._feedbackRestoreId = 0;
        }

        try {
            this._feedbackGroup.hide();
            logInfo('Suppressing rejected-drop snap-back feedback.');
        } catch (error) {
            console.error(`${LOG_PREFIX} Could not hide drag feedback: ${error.message}`);
            return;
        }

        this._feedbackRestoreId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FEEDBACK_SUPPRESS_MS,
            () => {
                this._feedbackRestoreId = 0;
                try {
                    this._feedbackGroup?.show();
                } catch {
                    // Shell may be shutting down or rebuilding the compositor.
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _restoreFeedbackGroup() {
        if (this._feedbackRestoreId) {
            GLib.source_remove(this._feedbackRestoreId);
            this._feedbackRestoreId = 0;
        }

        try {
            this._feedbackGroup?.show();
        } catch {
            // Safe during disable/session teardown.
        }
    }

    _refreshTrashActors() {
        const found = [];
        const stack = [Main.uiGroup];
        const seen = new Set();

        while (stack.length) {
            const actor = stack.pop();
            if (!actor || seen.has(actor))
                continue;
            seen.add(actor);

            if (isTrashActor(actor) && actorRect(actor))
                found.push(this._chooseTrashHitActor(actor));

            for (const child of safeChildren(actor))
                stack.push(child);
        }

        this._trashActors = [...new Set(found)].filter(actor => actorRect(actor));
    }

    _chooseTrashHitActor(actor) {
        // Dash-to-Dock stores the Shell.App on an inner icon actor on some
        // versions. Walk through only small wrapper actors so the hit target is
        // the whole icon cell without accidentally making the whole dock a target.
        let current = actor;
        let currentRect = actorRect(current);
        while (currentRect) {
            const parent = current.get_parent?.();
            if (!parent || parent === Main.uiGroup)
                break;
            const parentRect = actorRect(parent);
            if (!parentRect)
                break;

            const compact = parentRect.w <= currentRect.w * 1.8 &&
                parentRect.h <= currentRect.h * 1.8 &&
                parentRect.w <= 180 && parentRect.h <= 180;
            if (!compact)
                break;

            current = parent;
            currentRect = parentRect;
        }
        return current;
    }

    _findTrashAt(x, y) {
        let best = null;
        for (const actor of this._trashActors) {
            const rect = actorRect(actor);
            if (!rect || !contains(rect, x, y, 6))
                continue;

            const area = rect.w * rect.h;
            if (!best || area < best.area)
                best = {actor, rect, area};
        }
        return best;
    }

    _showHighlight(rect) {
        if (!this._highlight)
            return;
        this._highlight.set_position(Math.round(rect.x), Math.round(rect.y));
        this._highlight.set_size(Math.round(rect.w), Math.round(rect.h));
        this._highlight.show();
    }

    _hideHighlight() {
        this._highlight?.hide();
    }
}

'use strict';

import GLib from 'gi://GLib';

// Defer per-window work out of the `window-created` signal handler (the fork's
// "async hooks", task #144). The hook only calls push(window); a drain on
// GLib.idle_add(PRIORITY_LOW) runs `handler(window, batch)` for the queued
// windows within a time budget per idle turn (default 4 ms) and calls
// `commit(batch)` once per turn, so several new windows share one write.
//
// - A window that is unmanaged before its turn is dropped, never processed.
// - flush() drains everything synchronously (before code that reads the data:
//   closing a session, logout) and destroy() cancels the drain and
//   disconnects all signals.

const DEFAULT_BUDGET_US = 4000;

// The active queue, so code without a reference to the tracker (closeSession.js)
// can make the data it reads up to date.
let _active = null;

export function flushPendingWindows() {
    _active?.flush();
}

export class WindowQueue {
    // register: true makes this the queue flushPendingWindows() drains (the tracker's only)
    constructor(handler, commit, budgetUs = DEFAULT_BUDGET_US, {register = false} = {}) {
        this._handler = handler;
        this._commit = commit;
        this._budgetUs = budgetUs;
        this._items = [];       // [{window, time, unmanagingId}]
        this._idleId = 0;
        this._destroyed = false;
        this.turns = 0;         // idle turns used so far (for tests)
        this._registered = register;
        if (register) _active = this;
    }

    get size() {
        return this._items.length;
    }

    push(window) {
        if (this._destroyed || !window) return;
        const item = {window, time: GLib.get_monotonic_time(), unmanagingId: 0};
        try {
            item.unmanagingId = window.connect('unmanaging', () => {
                this._release(item);
                const i = this._items.indexOf(item);
                if (i >= 0) this._items.splice(i, 1);
            });
        } catch (e) {
            return;
        }
        this._items.push(item);
        this._schedule();
    }

    _schedule() {
        if (this._idleId || this._destroyed || !this._items.length) return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idleId = 0;
            this.turns++;
            this._drain(this._budgetUs);
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    _release(item) {
        if (item.unmanagingId) {
            try {
                item.window.disconnect(item.unmanagingId);
            } catch (e) { /* window already gone */ }
            item.unmanagingId = 0;
        }
    }

    // budgetUs = Infinity drains everything
    _drain(budgetUs) {
        const start = GLib.get_monotonic_time();
        const batch = {};
        let processed = 0;
        while (this._items.length) {
            const item = this._items.shift();
            this._release(item);
            try {
                this._handler(item.window, batch);
                processed++;
            } catch (e) {
                logError(e, 'another-window-session-manager: queued window handler');
            }
            if (GLib.get_monotonic_time() - start >= budgetUs) break;
        }
        if (processed) {
            try {
                this._commit(batch);
            } catch (e) {
                logError(e, 'another-window-session-manager: queue commit');
            }
        }
    }

    flush() {
        if (this._destroyed) return;
        this._drain(Infinity);
    }

    // Drop everything without processing (e.g. before the data is reset on logout)
    clear() {
        for (const item of this._items) this._release(item);
        this._items = [];
    }

    destroy() {
        this._destroyed = true;
        if (this._idleId) {
            GLib.Source.remove(this._idleId);
            this._idleId = 0;
        }
        this.clear();
        if (this._registered && _active === this) _active = null;
    }
}

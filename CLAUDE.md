# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Traqker is a self-hosted time tracker (v2 Phase 0) replacing Harvest. Stack:
- **Backend**: Python 3.11+, `aiohttp`, `aiosqlite` (SQLite database)
- **Frontend**: Vue 3 (Options API), LESS in-browser, no bundler — derived from `peter9477/wysiweb`
- **Wire protocol**: `{_t: "type", ...fields}` JSON over WebSocket (see `docs/protocol.md`)

## Directory Layout

```
server/
    main.py         — aiohttp app, WS handler, _msg_* dispatch
    db.py           — async SQLite layer (aiosqlite, hand-written SQL)
    schema.sql      — SQLite schema (ANSI-compatible for future Postgres migration)
    csv_export.py   — 7-column CSV emitter (import.py format)
www/
    index.html      — Vue 3 root + app markup (day/week/month views)
    index.js        — Vue 3 app: state, _msg_* handlers, UI events
    css/
        const.less  — palette seed variables (edit to re-theme)
        style.less  — layout framework + app-specific styles
        reset.css   — CSS reset (vendored, do not edit)
        all.min.css — Font Awesome icons (vendored, do not edit)
    js/
        lib.js      — Connector class + utilities (do not edit; reuse as-is)
        vue.global.prod.js  — Vue 3 (vendored)
        less.min.js — Less.js compiler (vendored)
docs/
    protocol.md     — WebSocket message catalog (spec for Rust rewrite)
wysiweb/            — upstream template repo (reference only)
import.py           — existing CSV → db.hours importer (DO NOT MODIFY)
harvest.py          — Harvest CSV → db.hours importer (DO NOT MODIFY)
hours.csv           — canonical example of import.py CSV format
project-log.rst     — dev log / notes
TODO.md             — deferred items
nonrepo_/           — gitignored scratch/archive folder
```

## Running the Server

```bash
# From the repo root:
cd /code/traqker
pip install aiohttp aiosqlite
python server/main.py                  # port 8500, db traqker.db
python server/main.py --port 8080
python server/main.py --db /path/to/traqker.db
python server/main.py -d               # debug logging

# Open: http://localhost:8500/app/
# WebSocket: ws://localhost:8500/app.ws
# Dev mode (LESS watch): add #dev to URL: http://localhost:8500/app/#dev
```

## Architecture

### Wire Protocol

Messages are `{_t: "type", ...fields}` JSON over WebSocket.
Handler dispatch by naming convention: `_msg_<type>` methods on `Client` (Python) and on the Vue instance (JavaScript).
`Connector` in `www/js/lib.js` dispatches incoming messages to `_msg_*` Vue methods.
Full message catalog: `docs/protocol.md`.

### Python Backend (`server/main.py`)

- `Client` class: one instance per WebSocket connection. Class-level `_all` set enables `broadcast()`.
- `on_connect()`: pushes `meta` + full `state` (today's entries + all lookup tables).
- `_msg_*` methods handle all client messages and broadcast entry/entity updates to all connected clients.
- DB operations delegate to `db.DB`. No in-memory caching — all reads go to SQLite.

### SQLite Schema (`server/schema.sql`)

Tables: `person`, `client`, `project`, `task`, `time_entry`.

`time_entry` key fields:
- `started_at`, `ended_at`: local-time ISO-8601 strings (`"YYYY-MM-DDTHH:MM:SS"`, no TZ suffix).
  Phase 0 stores local time. Phase 2 (Rust + Postgres) will use UTC timestamptz.
- `breaks`: JSON text — `[{"started_at": "...", "ended_at": "..."|null}, ...]`. Open break has `ended_at: null`.
- `billable`, `travel`: integers (0/1).

### JavaScript Frontend (`www/index.js`)

Vue 3 Options API. No build step.

**Key computed properties:**
- `active_entry` — entry with `ended_at === null`
- `day_entries` — entries filtered to `current_date` in local time
- `week_days`, `month_weeks` — date arrays for the week/month grid views

**Timestamp handling:** Phase 0 stores local time without TZ suffix. JavaScript's `new Date("2026-04-10T09:30:00")` parses this as local time (correct for Phase 0).

**Vue reactivity:** The app uses Vue 3's reactive proxy, so direct array mutation works (`this.entries[i] = e`). No need for `vm.$set`.

**`v-focus` directive:** Registered on the app; auto-focuses inputs when they appear (used for inline edit and split-form inputs).

### CSS

`style.less` imports `const.less` (palette) and adds layout helpers + app-specific styles.
Less.js compiles in-browser from `<link rel="stylesheet/less">`.
In dev mode (`#dev` URL flag), `less.watch()` polls for changes every 2s.

## CSV Export

`server/csv_export.py` produces 7-column CSV for `import.py`:
```
Date,Code,User,Start,stop,pause,Notes
```
- `Code`: `project.code || project.name.lower()` or `"admin"`.
- Non-billable override: prepend `"(not billed) "` to Notes when `entry.billable=0` but project default is billable.
- Travel encoding: `Code="travel"`, Notes prefixed with real code + `": "`.
- `pause`: total break seconds formatted as `H:MM`.
- Running entries are skipped.

## Key Implementation Notes

- Multiple running entries are allowed (parallel timers). Pause / resume / stop operate per-entry by id.
- `is_paused(e)`: entry has `ended_at === null` AND last break has `ended_at === null`.
- Split entry: original is shortened to `split_at`, a new entry is created from `split_at` onwards with the same metadata. Breaks are apportioned: breaks before split_at stay with the original; breaks after go to the new entry; a break straddling the split is truncated at split_at.
- Admin panel: manages clients, projects, tasks. All entity changes broadcast to all connected clients.
- `billable_default` on project is inherited when starting a new entry; can be overridden per-entry.

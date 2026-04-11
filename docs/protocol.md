# Traqker WebSocket Protocol

Wire format: `{_t: "type", ...fields}` JSON over WebSocket.
Endpoint: `/app.ws` (relative to the page URL).
Dispatcher: `Connector` from `www/js/lib.js` calls `_msg_TYPE(msg)` on the Vue instance.

---

## Server → Client

### `meta`
Sent immediately on connect. Used for cache-busting (hash change triggers reload).
```json
{"_t":"meta","version":"0.1.0","hostname":"dragon","hash":"a1b2c3d4"}
```

### `state`
Full state pushed on connect. Replaces all client-side state.
```json
{
    "_t": "state",
    "today": "2026-04-10",
    "person": {"id":1,"name":"Peter Hansen","nick":"peter","active":1},
    "entries":  [...],
    "clients":  [...],
    "projects": [...],
    "tasks":    [...]
}
```

### `entries`
Response to `load_entries`. Replaces entries in the queried date range.
```json
{"_t":"entries","entries":[...],"start_date":"2026-04-07","end_date":"2026-04-13"}
```

### `entry_update`
Broadcast after any entry create/modify. Upserts into the client's `entries` array.
```json
{"_t":"entry_update","entry": <time_entry>}
```

### `entry_delete`
Broadcast after delete.
```json
{"_t":"entry_delete","id":42}
```

### `entity_update`
Broadcast after create/update of a client, project, or task.
```json
{"_t":"entity_update","kind":"project","item": <project>}
```
`kind` is one of `"client"`, `"project"`, `"task"`.

### `entity_delete`
```json
{"_t":"entity_delete","kind":"client","id":7}
```

### `export_csv`
Response to `export_csv` request (sent only to the requesting client).
```json
{"_t":"export_csv","csv":"Date,Code,...\r\n...","filename":"traqker_2026-04-01_to_2026-04-30.csv"}
```

### `error`
Unhandled server error (message handler threw).
```json
{"_t":"error","text":"Server error in start_entry"}
```

---

## Client → Server

### `load_entries`
Load entries for a date range (local dates). Server responds with `entries`.
```json
{"_t":"load_entries","start_date":"2026-04-07","end_date":"2026-04-13"}
```

### `start_entry`
Start a new timer. Broadcasts `entry_update`.
```json
{
    "_t": "start_entry",
    "project_id": 3,      // optional
    "task_id": 1,         // optional
    "description": "...", // optional
    "billable": 1,        // defaults to project.billable_default or 1
    "travel": 0
}
```

### `stop_entry`
```json
{"_t":"stop_entry","id":42}
```

### `pause_entry`
Opens a new break interval on the running entry.
```json
{"_t":"pause_entry","id":42}
```

### `resume_entry`
Closes the open break interval.
```json
{"_t":"resume_entry","id":42}
```

### `update_entry`
Edit any field(s) of an entry. Broadcasts `entry_update`.
```json
{
    "_t": "update_entry",
    "id": 42,
    "started_at": "2026-04-10T09:30:00",
    "ended_at":   "2026-04-10T11:00:00",
    "description": "new text",
    "project_id": 3,
    "task_id": 1,
    "billable": 1,
    "travel": 0,
    "breaks": [{"started_at":"...","ended_at":"..."}]
}
```
All fields except `id` are optional.

### `delete_entry`
Broadcasts `entry_delete`.
```json
{"_t":"delete_entry","id":42}
```

### `split_entry`
Split one entry into two at `split_at`. Broadcasts two `entry_update` messages.
```json
{"_t":"split_entry","id":42,"split_at":"2026-04-10T10:15:00"}
```

### `create_client` / `update_client` / `delete_client`
```json
{"_t":"create_client","name":"Acme Corp","notes":"optional"}
{"_t":"update_client","id":1,"name":"Acme Corp 2","active":0}
{"_t":"delete_client","id":1}
```

### `create_project` / `update_project` / `delete_project`
```json
{"_t":"create_project","name":"Sprocket CMS","code":"p313","client_id":1,"billable_default":1}
{"_t":"update_project","id":3,"code":"p314"}
{"_t":"delete_project","id":3}
```

### `create_task` / `update_task` / `delete_task`
```json
{"_t":"create_task","name":"Meetings","project_id":3}
{"_t":"update_task","id":1,"name":"Standups","active":0}
{"_t":"delete_task","id":1}
```

### `export_csv`
Request a CSV export for a date range. Server responds with `export_csv`.
```json
{"_t":"export_csv","start_date":"2026-04-01","end_date":"2026-04-30"}
```

---

## Data shapes

### `time_entry`
```json
{
    "id": 42,
    "person_id": 1,
    "started_at": "2026-04-10T09:30:00",
    "ended_at":   "2026-04-10T11:00:00",   // null = running
    "client_id":  1,                         // null = none
    "project_id": 3,
    "task_id":    1,
    "billable":   1,
    "travel":     0,
    "description": "API planning",
    "breaks": [
        {"started_at":"2026-04-10T10:15:00","ended_at":"2026-04-10T10:30:00"}
    ],
    "created_at": "2026-04-10T09:30:00",
    "updated_at": "2026-04-10T11:00:00"
}
```

Derived (computed in the client, not stored):
- `net_seconds` = (ended_at or now) − started_at − sum(break durations)
- `gross_seconds` = (ended_at or now) − started_at
- `is_running` = ended_at IS NULL
- `is_paused` = is_running AND last break has ended_at IS NULL

---

## Timestamp format

Phase 0 stores local-time ISO-8601 without timezone suffix:
`"2026-04-10T09:30:00"` — interpreted as America/Toronto local time throughout.

Phase 2 (Rust + Postgres) will migrate to UTC timestamptz. The client will
need updating to parse UTC and render in local time at that point.

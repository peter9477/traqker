-- Traqker v2 Phase 0 schema — SQLite
-- Timestamps: local-time ISO-8601 strings "YYYY-MM-DDTHH:MM:SS" (no TZ suffix).
--   Phase 0 stores local time throughout for simplicity.
--   Phase 2 (Rust + Postgres) will migrate to proper UTC timestamptz.
-- breaks column: JSON text — [{"started_at": "...", "ended_at": "..."}, ...]
--   An open break has ended_at = null.
-- All FK references use ON DELETE SET NULL so deleting a lookup entity
--   orphans references (sets to null) rather than cascading.

CREATE TABLE IF NOT EXISTS person (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    nick      TEXT    NOT NULL UNIQUE,
    active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS client (
    id        INTEGER PRIMARY KEY,
    name      TEXT    NOT NULL,
    active    INTEGER NOT NULL DEFAULT 1,
    notes     TEXT
);

CREATE TABLE IF NOT EXISTS project (
    id               INTEGER PRIMARY KEY,
    client_id        INTEGER REFERENCES client(id) ON DELETE SET NULL,
    name             TEXT    NOT NULL,
    code             TEXT,
    active           INTEGER NOT NULL DEFAULT 1,
    notes            TEXT,
    billable_default INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS task (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES project(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS time_entry (
    id          INTEGER PRIMARY KEY,
    person_id   INTEGER NOT NULL REFERENCES person(id),
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    client_id   INTEGER REFERENCES client(id)  ON DELETE SET NULL,
    project_id  INTEGER REFERENCES project(id) ON DELETE SET NULL,
    task_id     INTEGER REFERENCES task(id)    ON DELETE SET NULL,
    billable    INTEGER NOT NULL DEFAULT 1,
    travel      INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    breaks      TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

-- Seed: single user. INSERT OR IGNORE is safe to re-run.
INSERT OR IGNORE INTO person (id, name, nick, active) VALUES (1, 'Peter Hansen', 'peter', 1);

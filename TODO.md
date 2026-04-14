# Traqker TODO

Items deferred from initial design. Not ordered by priority.

## Data / import-export

- [ ] JSON import/export for full-fidelity data migration (richer than CSV; use for
      moving data between server instances or migrating from old system). CSV is fine
      for reporting output; JSON is the round-trip format.
- [ ] Harvest CSV import — parse the Harvest CSV format and load into the new schema
      (useful for seeding test data and eventual cutover). `harvest.py` does not exist
      in the repo yet; needs sample Harvest CSVs to develop against.
- [ ] Decide on timezone boundary for entries spanning midnight: local-midnight vs
      UTC-midnight. Current default assumption: local.

## Entities / data model

- [ ] Tags — old system used free-form tags that doubled as project codes. Dropped from
      v1 since Client/Project/Task hierarchy covers it. Add back if the hierarchy proves
      too rigid in practice.
- [ ] "Task" naming — consider renaming to "activity" or "category" if "task" conflicts
      with user's mental model of project tasks (e.g. JIRA issues).
- [x] `billable` flag default per project — `billable_default` column on `project`
      table; inherited when starting a new entry for that project.
- [ ] `billable` flag default per task — task table has no `billable_default` yet.
      Could allow a task to override the project default (e.g. "admin" task always
      non-billable within a billable project).

## Operations

- [x] Edit break times — inline edit of break start/end times within an entry.
- [x] Delete breaks — removes a break from an entry (requires two-step confirm).
- [x] Split entry — original is shortened to split point; new entry created from
      split point onward; breaks apportioned across the two entries.
- [ ] Merge entries — combine two adjacent entries into one (complement of split).
- [ ] Undo for delete — probably a soft-delete + recycle bin or a recent-actions queue.
- [ ] Bulk edit — change project/task/billable across multiple entries at once
      (useful after forgetting to switch for a long stretch).
- [ ] Quick-fill / autocomplete — pre-fill new entry from most recent entry for same
      client/project, or from a saved "template" entry.

## UI

- [x] Privacy mode — toggle to blur entry descriptions on-screen (useful for
      screen-sharing). Entries marked private are blurred; toggle reveals them.
- [ ] Month view detail — clicking a day in month view drills into day view.
- [ ] Keyboard shortcuts spec — document and expose bindings (start/stop/pause/resume,
      prev/next/today, view switching).
- [ ] Mobile polish — works in mobile browser already (target); visual polish is deferred.
- [x] Dark mode — `html.dark` class toggle; auto-activated from `prefers-color-scheme`
      on first visit; persisted to `localStorage`.

## Infrastructure

- [ ] Auth — single-user password or OIDC, needed before remote/public access.
      Deferred until Phase 2 (Rust rewrite).
- [ ] TLS — reverse proxy (nginx/caddy) or native (rustls). Deferred until Phase 3.
- [ ] Multi-user — person table exists from day one; wiring up accounts is Phase 3.
- [ ] Postgres migration — from SQLite (Phase 0/1) to Postgres (Phase 2, Rust).
      Keep schema ANSI-compatible to make this mechanical.

## CSV export

- [x] CSV format confirmed: `Date,Code,User,Start,stop,pause,Notes` per `hours.csv`.
      Feeds `import.py` directly with no converter needed.
- [x] CSV export endpoint implemented (`_msg_export_csv` → `csv_export.py`); accessible
      from the UI.
- [ ] `import.py` currently reads from a hardcoded `hours.csv` filename by default.
      When using it with Traqker CSV output, need to specify a different path or patch
      the default. Trivial but document the invocation.

"""
db.py — async SQLite layer (aiosqlite) for Traqker v2 Phase 0.

All timestamps are local-time ISO-8601 strings ("YYYY-MM-DDTHH:MM:SS").
The breaks column is JSON text: [{"started_at": "...", "ended_at": "..."}, ...]
"""

import json
from datetime import datetime
from pathlib import Path

import aiosqlite

SCHEMA = Path(__file__).parent / 'schema.sql'


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


class DB:
    def __init__(self):
        self._db: aiosqlite.Connection | None = None

    async def init(self, path: str):
        self._db = await aiosqlite.connect(path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute('PRAGMA journal_mode=DELETE')
        await self._db.execute('PRAGMA foreign_keys=ON')
        await self._db.executescript(SCHEMA.read_text())
        await self._db.commit()

    async def close(self):
        if self._db:
            await self._db.close()

    # ---- internal helpers --------------------------------------------------

    def _row(self, row) -> dict | None:
        if row is None:
            return None
        d = dict(row)
        if 'breaks' in d and isinstance(d['breaks'], str):
            d['breaks'] = json.loads(d['breaks'])
        return d

    def _rows(self, rows) -> list[dict]:
        return [self._row(r) for r in rows]

    # ---- person ------------------------------------------------------------

    async def get_person(self) -> dict | None:
        async with self._db.execute(
            'SELECT * FROM person WHERE active=1 ORDER BY id LIMIT 1'
        ) as cur:
            return self._row(await cur.fetchone())

    # ---- entries -----------------------------------------------------------

    async def get_entry(self, id: int) -> dict | None:
        async with self._db.execute('SELECT * FROM time_entry WHERE id=?', (id,)) as cur:
            return self._row(await cur.fetchone())

    async def get_entries(self, start: str, end: str) -> list[dict]:
        """Entries where started_at falls in [start, end] (inclusive ISO strings)."""
        async with self._db.execute(
            'SELECT * FROM time_entry WHERE started_at >= ? AND started_at <= ? ORDER BY started_at',
            (start, end),
        ) as cur:
            return self._rows(await cur.fetchall())

    async def get_running_entries(self) -> list[dict]:
        async with self._db.execute(
            'SELECT * FROM time_entry WHERE ended_at IS NULL ORDER BY started_at'
        ) as cur:
            return self._rows(await cur.fetchall())

    async def create_entry(self, person_id: int, started_at: str, **fields) -> dict:
        now = _now()
        sql = '''
            INSERT INTO time_entry
                (person_id, started_at, ended_at, client_id, project_id, task_id,
                 billable, travel, description, breaks, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        '''
        vals = (
            person_id,
            started_at,
            fields.get('ended_at'),
            fields.get('client_id'),
            fields.get('project_id'),
            fields.get('task_id'),
            int(fields.get('billable', 1)),
            int(fields.get('travel', 0)),
            fields.get('description'),
            json.dumps(fields.get('breaks', [])),
            now, now,
        )
        async with self._db.execute(sql, vals) as cur:
            entry_id = cur.lastrowid
        await self._db.commit()
        return await self.get_entry(entry_id)

    async def update_entry(self, id: int, **fields) -> dict:
        _allowed = {
            'started_at', 'ended_at', 'client_id', 'project_id', 'task_id',
            'billable', 'travel', 'description', 'breaks',
        }
        sets, vals = [], []
        for k, v in fields.items():
            if k not in _allowed:
                continue
            sets.append(f'{k}=?')
            vals.append(json.dumps(v) if k == 'breaks' else v)
        if sets:
            sets.append('updated_at=?')
            vals.extend([_now(), id])
            await self._db.execute(
                f'UPDATE time_entry SET {", ".join(sets)} WHERE id=?', vals
            )
            await self._db.commit()
        return await self.get_entry(id)

    async def delete_entry(self, id: int):
        await self._db.execute('DELETE FROM time_entry WHERE id=?', (id,))
        await self._db.commit()

    # ---- clients -----------------------------------------------------------

    async def get_clients(self) -> list[dict]:
        async with self._db.execute('SELECT * FROM client ORDER BY name') as cur:
            return self._rows(await cur.fetchall())

    async def create_client(self, name: str, notes: str | None = None) -> dict:
        async with self._db.execute(
            'INSERT INTO client (name, notes) VALUES (?,?)', (name, notes)
        ) as cur:
            cid = cur.lastrowid
        await self._db.commit()
        async with self._db.execute('SELECT * FROM client WHERE id=?', (cid,)) as cur:
            return self._row(await cur.fetchone())

    async def update_client(self, id: int, **fields) -> dict:
        _allowed = {'name', 'notes', 'active'}
        sets, vals = [], []
        for k, v in fields.items():
            if k in _allowed:
                sets.append(f'{k}=?'); vals.append(v)
        if sets:
            vals.append(id)
            await self._db.execute(f'UPDATE client SET {", ".join(sets)} WHERE id=?', vals)
            await self._db.commit()
        async with self._db.execute('SELECT * FROM client WHERE id=?', (id,)) as cur:
            return self._row(await cur.fetchone())

    async def delete_client(self, id: int):
        await self._db.execute('DELETE FROM client WHERE id=?', (id,))
        await self._db.commit()

    # ---- projects ----------------------------------------------------------

    async def get_projects(self) -> list[dict]:
        async with self._db.execute('SELECT * FROM project ORDER BY name') as cur:
            return self._rows(await cur.fetchall())

    async def create_project(self, name: str, **fields) -> dict:
        sql = '''
            INSERT INTO project (client_id, name, code, billable_default, notes)
            VALUES (?,?,?,?,?)
        '''
        async with self._db.execute(sql, (
            fields.get('client_id'),
            name,
            fields.get('code'),
            int(fields.get('billable_default', 1)),
            fields.get('notes'),
        )) as cur:
            pid = cur.lastrowid
        await self._db.commit()
        async with self._db.execute('SELECT * FROM project WHERE id=?', (pid,)) as cur:
            return self._row(await cur.fetchone())

    async def update_project(self, id: int, **fields) -> dict:
        _allowed = {'client_id', 'name', 'code', 'billable_default', 'notes', 'active'}
        sets, vals = [], []
        for k, v in fields.items():
            if k in _allowed:
                sets.append(f'{k}=?'); vals.append(v)
        if sets:
            vals.append(id)
            await self._db.execute(f'UPDATE project SET {", ".join(sets)} WHERE id=?', vals)
            await self._db.commit()
        async with self._db.execute('SELECT * FROM project WHERE id=?', (id,)) as cur:
            return self._row(await cur.fetchone())

    async def delete_project(self, id: int):
        await self._db.execute('DELETE FROM project WHERE id=?', (id,))
        await self._db.commit()

    # ---- tasks -------------------------------------------------------------

    async def get_tasks(self) -> list[dict]:
        async with self._db.execute('SELECT * FROM task ORDER BY name') as cur:
            return self._rows(await cur.fetchall())

    async def create_task(self, name: str, project_id: int | None = None) -> dict:
        async with self._db.execute(
            'INSERT INTO task (name, project_id) VALUES (?,?)', (name, project_id)
        ) as cur:
            tid = cur.lastrowid
        await self._db.commit()
        async with self._db.execute('SELECT * FROM task WHERE id=?', (tid,)) as cur:
            return self._row(await cur.fetchone())

    async def update_task(self, id: int, **fields) -> dict:
        _allowed = {'name', 'project_id', 'active'}
        sets, vals = [], []
        for k, v in fields.items():
            if k in _allowed:
                sets.append(f'{k}=?'); vals.append(v)
        if sets:
            vals.append(id)
            await self._db.execute(f'UPDATE task SET {", ".join(sets)} WHERE id=?', vals)
            await self._db.commit()
        async with self._db.execute('SELECT * FROM task WHERE id=?', (id,)) as cur:
            return self._row(await cur.fetchone())

    async def delete_task(self, id: int):
        await self._db.execute('DELETE FROM task WHERE id=?', (id,))
        await self._db.commit()

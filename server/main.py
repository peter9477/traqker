#!/usr/bin/env python3
"""
Traqker v2 Phase 0 — aiohttp server

Usage:
    python3 server/main.py
    python3 server/main.py --port 8500
    python3 server/main.py --db traqker.db
    python3 server/main.py -d          # debug logging

Serves www/ at /app/ and WebSocket at /app.ws.
"""

import argparse
import asyncio
import hashlib
import json
import logging
import signal
import socket
import sys
from datetime import datetime
from pathlib import Path

from aiohttp import web

# Allow running from project root or from server/
sys.path.insert(0, str(Path(__file__).parent))
from db import DB
from csv_export import export_csv

VERSION = '0.1.0'
WWW = Path(__file__).parent.parent / 'www'

log = logging.getLogger('traqker')


def _now() -> str:
    return datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


def _source_hash() -> str:
    """Short hash of source file mtimes for cache-busting."""
    h = hashlib.md5()
    for f in sorted(Path(__file__).parent.glob('*.py')):
        try:
            h.update(f.stat().st_mtime_ns.to_bytes(8, 'little'))
        except OSError:
            pass
    for f in sorted(WWW.rglob('*')):
        if f.suffix in ('.js', '.less', '.html', '.css'):
            try:
                h.update(f.stat().st_mtime_ns.to_bytes(8, 'little'))
            except OSError:
                pass
    return h.hexdigest()[:8]


# ---------------------------------------------------------------------------
# Per-connection client

class Client:
    _all: set['Client'] = set()

    def __init__(self, ws: web.WebSocketResponse, db: DB):
        self.ws = ws
        self.db = db
        Client._all.add(self)

    async def disconnect(self):
        Client._all.discard(self)

    async def send(self, **msg):
        try:
            await self.ws.send_json(msg)
        except Exception as e:
            log.debug(f'send failed: {e}')

    @classmethod
    async def broadcast(cls, **msg):
        for c in list(cls._all):
            await c.send(**msg)

    # ---- connect -----------------------------------------------------------

    async def on_connect(self):
        await self.send(_t='meta', version=VERSION, hostname=socket.gethostname(),
                        hash=_source_hash())
        await self._push_state()

    async def _push_state(self):
        today = datetime.now().strftime('%Y-%m-%d')
        start = today + 'T00:00:00'
        end   = today + 'T23:59:59'
        entries = await self.db.get_entries(start, end)
        running = await self.db.get_running_entry()
        # Include running entry even if it started before today
        if running and not any(e['id'] == running['id'] for e in entries):
            entries = [running] + entries
        await self.send(
            _t='state',
            today=today,
            person=await self.db.get_person(),
            entries=entries,
            clients=await self.db.get_clients(),
            projects=await self.db.get_projects(),
            tasks=await self.db.get_tasks(),
        )

    # ---- dispatch ----------------------------------------------------------

    async def dispatch(self, msg: dict):
        t = msg.get('_t', '')
        handler = getattr(self, f'_msg_{t}', None)
        if handler:
            try:
                await handler(msg)
            except Exception:
                log.exception(f'_msg_{t} raised')
                await self.send(_t='error', text=f'Server error in {t}')
        else:
            log.warning(f'unhandled: {t!r}')

    # ---- entry handlers ----------------------------------------------------

    async def _msg_load_entries(self, msg):
        start_date = msg['start_date']
        end_date   = msg.get('end_date', start_date)
        entries = await self.db.get_entries(start_date + 'T00:00:00', end_date + 'T23:59:59')
        await self.send(_t='entries', entries=entries,
                        start_date=start_date, end_date=end_date)

    async def _msg_start_entry(self, msg):
        person = await self.db.get_person()
        project_id = msg.get('project_id')
        billable = msg.get('billable')
        if billable is None and project_id:
            projects = await self.db.get_projects()
            proj = next((p for p in projects if p['id'] == project_id), None)
            billable = proj['billable_default'] if proj else 1
        if billable is None:
            billable = 1
        entry = await self.db.create_entry(
            person_id=person['id'],
            started_at=_now(),
            client_id=msg.get('client_id'),
            project_id=project_id,
            task_id=msg.get('task_id'),
            billable=int(billable),
            travel=int(msg.get('travel', 0)),
            description=msg.get('description', ''),
        )
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_create_entry(self, msg):
        """Create an entry with explicit started_at (and optional ended_at)."""
        person = await self.db.get_person()
        project_id = msg.get('project_id')
        billable = msg.get('billable')
        if billable is None and project_id:
            projects = await self.db.get_projects()
            proj = next((p for p in projects if p['id'] == project_id), None)
            billable = proj['billable_default'] if proj else 1
        if billable is None:
            billable = 1
        entry = await self.db.create_entry(
            person_id=person['id'],
            started_at=msg['started_at'],
            ended_at=msg.get('ended_at'),
            client_id=msg.get('client_id'),
            project_id=project_id,
            task_id=msg.get('task_id'),
            billable=int(billable),
            travel=int(msg.get('travel', 0)),
            description=msg.get('description', ''),
        )
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_stop_entry(self, msg):
        id = int(msg['id'])
        entry = await self.db.get_entry(id)
        if not entry or entry['ended_at'] is not None:
            return
        breaks = entry['breaks']
        if breaks and breaks[-1]['ended_at'] is None:
            breaks[-1]['ended_at'] = _now()
        entry = await self.db.update_entry(id, ended_at=_now(), breaks=breaks)
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_pause_entry(self, msg):
        id = int(msg['id'])
        entry = await self.db.get_entry(id)
        if not entry or entry['ended_at'] is not None:
            return
        breaks = entry['breaks']
        if not breaks or breaks[-1]['ended_at'] is not None:
            breaks.append({'started_at': _now(), 'ended_at': None})
            entry = await self.db.update_entry(id, breaks=breaks)
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_resume_entry(self, msg):
        id = int(msg['id'])
        entry = await self.db.get_entry(id)
        if not entry or entry['ended_at'] is not None:
            return
        breaks = entry['breaks']
        if breaks and breaks[-1]['ended_at'] is None:
            breaks[-1]['ended_at'] = _now()
            entry = await self.db.update_entry(id, breaks=breaks)
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_update_entry(self, msg):
        id = int(msg['id'])
        fields = {k: v for k, v in msg.items() if k not in ('_t', 'id')}
        entry = await self.db.update_entry(id, **fields)
        await Client.broadcast(_t='entry_update', entry=entry)

    async def _msg_delete_entry(self, msg):
        id = int(msg['id'])
        await self.db.delete_entry(id)
        await Client.broadcast(_t='entry_delete', id=id)

    async def _msg_split_entry(self, msg):
        """Split entry at split_at (local ISO string). Produces two entries."""
        id       = int(msg['id'])
        split_at = msg['split_at']          # "YYYY-MM-DDTHH:MM:SS"
        entry    = await self.db.get_entry(id)
        if not entry:
            return

        breaks   = entry['breaks']
        breaks_a, breaks_b = [], []
        for b in breaks:
            if b['started_at'] >= split_at:
                breaks_b.append(b)
            elif b['ended_at'] is None or b['ended_at'] > split_at:
                # Break straddles split point — truncate at split
                breaks_a.append({'started_at': b['started_at'], 'ended_at': split_at})
            else:
                breaks_a.append(b)

        updated   = await self.db.update_entry(id, ended_at=split_at, breaks=breaks_a)
        person    = await self.db.get_person()
        new_entry = await self.db.create_entry(
            person_id=person['id'],
            started_at=split_at,
            ended_at=entry['ended_at'],
            client_id=entry['client_id'],
            project_id=entry['project_id'],
            task_id=entry['task_id'],
            billable=entry['billable'],
            travel=entry['travel'],
            description=entry['description'],
            breaks=breaks_b,
        )
        await Client.broadcast(_t='entry_update', entry=updated)
        await Client.broadcast(_t='entry_update', entry=new_entry)

    # ---- entity CRUD -------------------------------------------------------

    async def _msg_create_client(self, msg):
        item = await self.db.create_client(msg['name'], msg.get('notes'))
        await Client.broadcast(_t='entity_update', kind='client', item=item)

    async def _msg_update_client(self, msg):
        fields = {k: v for k, v in msg.items() if k not in ('_t', 'id')}
        item = await self.db.update_client(int(msg['id']), **fields)
        await Client.broadcast(_t='entity_update', kind='client', item=item)

    async def _msg_delete_client(self, msg):
        id = int(msg['id'])
        await self.db.delete_client(id)
        await Client.broadcast(_t='entity_delete', kind='client', id=id)

    async def _msg_create_project(self, msg):
        fields = {k: v for k, v in msg.items() if k not in ('_t', 'name')}
        item = await self.db.create_project(msg['name'], **fields)
        await Client.broadcast(_t='entity_update', kind='project', item=item)

    async def _msg_update_project(self, msg):
        fields = {k: v for k, v in msg.items() if k not in ('_t', 'id')}
        item = await self.db.update_project(int(msg['id']), **fields)
        await Client.broadcast(_t='entity_update', kind='project', item=item)

    async def _msg_delete_project(self, msg):
        id = int(msg['id'])
        await self.db.delete_project(id)
        await Client.broadcast(_t='entity_delete', kind='project', id=id)

    async def _msg_create_task(self, msg):
        item = await self.db.create_task(msg['name'], msg.get('project_id'))
        await Client.broadcast(_t='entity_update', kind='task', item=item)

    async def _msg_update_task(self, msg):
        fields = {k: v for k, v in msg.items() if k not in ('_t', 'id')}
        item = await self.db.update_task(int(msg['id']), **fields)
        await Client.broadcast(_t='entity_update', kind='task', item=item)

    async def _msg_delete_task(self, msg):
        id = int(msg['id'])
        await self.db.delete_task(id)
        await Client.broadcast(_t='entity_delete', kind='task', id=id)

    async def _msg_export_csv(self, msg):
        start_date = msg['start_date']
        end_date   = msg.get('end_date', start_date)
        entries  = await self.db.get_entries(start_date + 'T00:00:00', end_date + 'T23:59:59')
        projects = await self.db.get_projects()
        person   = await self.db.get_person()
        csv_text = export_csv(entries, projects, person)
        filename = f'traqker_{start_date}_to_{end_date}.csv'
        await self.send(_t='export_csv', csv=csv_text, filename=filename)


# ---------------------------------------------------------------------------
# aiohttp wiring

async def ws_handler(request):
    db: DB = request.app['db']
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    client = Client(ws, db)
    log.info(f'ws connected from {request.remote}')
    await client.on_connect()

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    log.warning(f'bad JSON: {msg.data!r}')
                    continue
                await client.dispatch(data)
            elif msg.type == web.WSMsgType.ERROR:
                log.warning(f'ws error: {ws.exception()}')
    finally:
        await client.disconnect()
        log.info('ws disconnected')
    return ws


async def redirect_root(request):
    raise web.HTTPFound('/app/index.html')


async def on_startup(app):
    db = DB()
    await db.init(app['db_path'])
    app['db'] = db
    log.info(f'database: {app["db_path"]}')


async def on_cleanup(app):
    await app['db'].close()


async def _run(args):
    app = web.Application()
    app['db_path'] = args.db
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    app.router.add_get('/',       redirect_root)
    app.router.add_get('/app/',   redirect_root)
    app.router.add_get('/app.ws', ws_handler)
    app.router.add_static('/app/', WWW, show_index=True)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', args.port)
    await site.start()
    log.info(f'http://0.0.0.0:{args.port}/app/')

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGINT,  stop.set)
    loop.add_signal_handler(signal.SIGTERM, stop.set)

    await stop.wait()
    log.info('shutting down')
    for client in list(Client._all):
        await client.ws.close()
    await asyncio.sleep(0)   # let WS handlers process the close and exit
    await runner.cleanup()


def main():
    ap = argparse.ArgumentParser(description='Traqker v2 server')
    ap.add_argument('--port', '-p', type=int, default=8500)
    ap.add_argument('--db',         default='traqker.db', help='SQLite database path')
    ap.add_argument('-d', '--debug', action='store_true')
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
    )

    asyncio.run(_run(args))


if __name__ == '__main__':
    main()

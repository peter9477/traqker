"""
csv_export.py — 7-column CSV emitter compatible with import.py.

Output format (import.py positional columns):
    Date,Code,User,Start,stop,pause,Notes

Conventions (from import.py + hours.csv):
- Code: project.code if set, else project.name.lower(); fallback 'admin'.
- Billable override: if entry.billable=0 but project.billable_default=1,
  prepend "(not billed) " to Notes (import.py:604-607 detects this prefix).
- Travel: if entry.travel=1, emit Code='travel' and prepend real_code+': '
  to Notes (import.py:551-556 re-extracts the real project from Notes).
- pause: total break duration as "H:MM" (e.g. "0:45"), matching hours.csv style.
- Running entries (ended_at=None) are skipped.
"""

import csv
import io
from datetime import datetime


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _break_total_seconds(breaks: list) -> int:
    total = 0
    for b in breaks:
        if b.get('started_at') and b.get('ended_at'):
            s = _parse_dt(b['started_at'])
            e = _parse_dt(b['ended_at'])
            total += max(0, int((e - s).total_seconds()))
    return total


def _fmt_hhmm(dt: datetime) -> str:
    return dt.strftime('%H:%M')


def _fmt_pause(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m = rem // 60
    return f'{h}:{m:02d}'


def _project_code(proj: dict | None) -> str:
    if proj is None:
        return 'admin'
    code = proj.get('code') or proj.get('name', 'admin')
    return code.lower()


def export_csv(entries: list, projects: list, person: dict) -> str:
    proj_map: dict[int, dict] = {p['id']: p for p in projects}
    nick = person.get('nick', 'peter')

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator='\r\n')
    writer.writerow(['Date', 'Code', 'User', 'Start', 'stop', 'pause', 'Notes'])

    for e in sorted(entries, key=lambda x: x['started_at']):
        if not e.get('ended_at'):
            continue  # skip running entry

        started = _parse_dt(e['started_at'])
        ended   = _parse_dt(e['ended_at'])

        date_str  = started.strftime('%Y-%m-%d')
        start_str = _fmt_hhmm(started)
        stop_str  = _fmt_hhmm(ended)
        pause_str = _fmt_pause(_break_total_seconds(e.get('breaks', [])))

        proj = proj_map.get(e.get('project_id'))
        code = _project_code(proj)

        notes = (e.get('description') or '').strip()

        # Non-billable override: only needed when project default is billable
        proj_billable = proj['billable_default'] if proj else 1
        if proj_billable and not e.get('billable', 1):
            notes = f'(not billed) {notes}'.strip()

        # Travel flag encoding
        if e.get('travel'):
            notes = f'{code}: {notes}'.strip(': ').strip()
            code  = 'travel'

        writer.writerow([date_str, code, nick, start_str, stop_str, pause_str, notes])

    return buf.getvalue()

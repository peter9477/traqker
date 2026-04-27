"""Server-side reminder rules evaluated on a background tick."""

import asyncio
import logging
from datetime import datetime, date

log = logging.getLogger(__name__)

# ---- Tunable constants -------------------------------------------------------

TICK_SECONDS = 60

# Quiet hours: suppress all notifications from QUIET_FROM until QUIET_UNTIL (local).
# Dedup-set reset at midnight still happens so rules re-fire cleanly once quiet ends.
QUIET_FROM  = 23   # 11 pm
QUIET_UNTIL = 8    # 8 am

# Entries started before WAKING_HOUR are treated as overnight carry-over from the
# previous workday, not as today's activity. Used by no_activity and
# post_break_gap so reminders key on the user's waking day, not the calendar day.
WAKING_HOUR = 6

# Rule: running_late
# A timer that started on a weekday before RUNNING_LATE_STARTED_BEFORE is still
# running at or after RUNNING_LATE_AFTER. Fires once per entry per day.
RUNNING_LATE_STARTED_BEFORE = 17   # 5 pm
RUNNING_LATE_AFTER          = 19   # 7 pm

# Rule: running_very_late
# A timer that started on a weekday has been running for at least
# RUNNING_VERY_LATE_MIN_HOURS and is still going at or after RUNNING_VERY_LATE_AFTER.
# Second escalation after running_late. Fires once per entry per day.
RUNNING_VERY_LATE_AFTER     = 22   # 10 pm
RUNNING_VERY_LATE_MIN_HOURS = 4

# Rule: runaway
# A timer has been running for RUNAWAY_HOURS or more, and either started on a
# weekday or has crossed midnight into a new day. The weekend grace is intentional
# — a long Saturday timer for personal work shouldn't fire — but once the timer
# crosses into a new day it's almost certainly forgotten. Fires once per entry
# per day (resets at midnight).
RUNAWAY_HOURS = 8

# Rule: no_activity
# Weekdays only. By NO_ACTIVITY_BY_HOUR, not a single entry has been started today.
NO_ACTIVITY_BY_HOUR = 12          # noon

# Rule: post_break_gap
# Weekdays only. No timer running, at least one completed entry from today's
# workday started before POST_BREAK_MORNING_BEFORE, most recent stop
# >= POST_BREAK_GAP_HOURS ago.
POST_BREAK_MORNING_BEFORE = 12    # noon
POST_BREAK_GAP_HOURS      = 2
POST_BREAK_LATEST_HOUR    = 17    # 5 pm — silent after typical end of day

# ------------------------------------------------------------------------------


def _is_weekday(d: date) -> bool:
    return d.weekday() < 5   # Mon=0 … Fri=4


def _is_todays_workday(e: dict, today: date) -> bool:
    """True if entry started today at/after WAKING_HOUR — i.e. part of today's
    waking workday, not an overnight tail from the previous day."""
    started = datetime.fromisoformat(e['started_at'])
    return started.date() == today and started.hour >= WAKING_HOUR


async def reminder_loop(db, broadcast):
    """Evaluate reminder rules every TICK_SECONDS and broadcast notify messages.

    Args:
        db: DB instance (server/db.py)
        broadcast: Client.broadcast class method — async callable(**msg)
    """
    fired: set[tuple] = set()
    last_date: date = date.today()

    while True:
        await asyncio.sleep(TICK_SECONDS)
        try:
            now   = datetime.now()
            today = now.date()

            # Reset dedup set at local midnight
            if today != last_date:
                if fired:
                    log.info(f'daily reset: clearing {len(fired)} reminder key(s)')
                fired.clear()
                last_date = today

            if now.hour >= QUIET_FROM or now.hour < QUIET_UNTIL:
                continue

            today_str   = today.isoformat()
            today_start = today_str + 'T00:00:00'
            today_end   = today_str + 'T23:59:59'

            running   = await db.get_running_entries()
            all_today = await db.get_entries(today_start, today_end)

            # -- Rule: running_late --------------------------------------------
            # Fires on any day of week if the timer started on a weekday,
            # so a Friday timer left running over the weekend still alerts.
            if now.hour >= RUNNING_LATE_AFTER:
                for e in running:
                    started = datetime.fromisoformat(e['started_at'])
                    if _is_weekday(started.date()) and started.hour < RUNNING_LATE_STARTED_BEFORE:
                        key = ('running_late', today_str, e['id'])
                        if key not in fired:
                            fired.add(key)
                            log.info(f'reminder running_late: entry {e["id"]}')
                            await broadcast(
                                _t='notify',
                                kind='running_late',
                                title='Timer still running',
                                body=(f'A timer started before '
                                      f'{RUNNING_LATE_STARTED_BEFORE}:00 '
                                      f'is still running.'),
                                entry_id=e['id'],
                            )
                    else:
                        skip_key = ('running_late_skip', today_str, e['id'])
                        if skip_key not in fired:
                            fired.add(skip_key)
                            log.info(f'skip running_late entry {e["id"]}: started {started:%a at %H:%M}, not eligible')

            # -- Rule: running_very_late ---------------------------------------
            # Second escalation at 22:00 if the timer has been going >= 4h.
            # Fires any day — a long-running timer left overnight is always worth flagging.
            if now.hour >= RUNNING_VERY_LATE_AFTER:
                for e in running:
                    started = datetime.fromisoformat(e['started_at'])
                    hours   = (now - started).total_seconds() / 3600
                    if hours >= RUNNING_VERY_LATE_MIN_HOURS:
                        key = ('running_very_late', today_str, e['id'])
                        if key not in fired:
                            fired.add(key)
                            log.info(f'reminder running_very_late: entry {e["id"]} ({hours:.1f}h)')
                            await broadcast(
                                _t='notify',
                                kind='running_very_late',
                                title='Timer running very late',
                                body=(f'A timer has been running for '
                                      f'{hours:.0f}h — did you forget to stop it?'),
                                entry_id=e['id'],
                            )

            # -- Rule: runaway -------------------------------------------------
            # Fires if the timer started on a weekday, OR it has crossed midnight
            # into a new day (so a forgotten weekend timer alerts once it's run
            # overnight). running_very_late at 22:00 still covers same-day weekend
            # cases ≥4h.
            for e in running:
                started = datetime.fromisoformat(e['started_at'])
                hours   = (now - started).total_seconds() / 3600
                if hours >= RUNAWAY_HOURS:
                    eligible = _is_weekday(started.date()) or today != started.date()
                    if eligible:
                        key = ('runaway', today_str, e['id'])
                        if key not in fired:
                            fired.add(key)
                            log.info(f'reminder runaway: entry {e["id"]} ({hours:.1f}h)')
                            await broadcast(
                                _t='notify',
                                kind='runaway',
                                title='Timer running very long',
                                body=(f'A timer has been running for '
                                      f'{hours:.0f}h.'),
                                entry_id=e['id'],
                            )
                    else:
                        skip_key = ('runaway_skip', today_str, e['id'])
                        if skip_key not in fired:
                            fired.add(skip_key)
                            log.info(f'skip runaway entry {e["id"]}: started {started:%A} (non-weekday, same day), {hours:.1f}h running')

            # -- Weekday-only rules below --------------------------------------
            if not _is_weekday(today):
                continue

            # -- Rule: no_activity ---------------------------------------------
            if now.hour >= NO_ACTIVITY_BY_HOUR:
                key = ('no_activity', today_str, 0)
                workday_entries = [
                    e for e in all_today + running
                    if _is_todays_workday(e, today)
                ]
                if key not in fired and not workday_entries:
                    fired.add(key)
                    log.info('reminder no_activity')
                    await broadcast(
                        _t='notify',
                        kind='no_activity',
                        title='No timers started today',
                        body='No time has been tracked yet today.',
                        entry_id=None,
                    )

            # -- Rule: post_break_gap ------------------------------------------
            key2 = ('post_break_gap', today_str, 0)
            if key2 not in fired and not running:
                morning_entries = [
                    e for e in all_today
                    if e['ended_at'] is not None
                    and _is_todays_workday(e, today)
                    and datetime.fromisoformat(e['started_at']).hour < POST_BREAK_MORNING_BEFORE
                ]
                if morning_entries:
                    completed = [
                        e for e in all_today
                        if e['ended_at'] is not None and _is_todays_workday(e, today)
                    ]
                    if completed:
                        last_stop_str = max(e['ended_at'] for e in completed)
                        last_stop_dt  = datetime.fromisoformat(last_stop_str)
                        gap_hours     = (now - last_stop_dt).total_seconds() / 3600
                        if gap_hours >= POST_BREAK_GAP_HOURS:
                            if now.hour >= POST_BREAK_LATEST_HOUR:
                                skip_key = ('post_break_gap_eod', today_str, 0)
                                if skip_key not in fired:
                                    fired.add(skip_key)
                                    log.info(f'skip post_break_gap: {gap_hours:.1f}h gap suppressed by end-of-day cutoff')
                            else:
                                fired.add(key2)
                                log.info(f'reminder post_break_gap: {gap_hours:.1f}h since last stop')
                                await broadcast(
                                    _t='notify',
                                    kind='post_break_gap',
                                    title='Did you forget to start a timer?',
                                    body=(f'No timer running — last one stopped '
                                          f'{gap_hours:.0f}h ago.'),
                                    entry_id=None,
                                )

        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception('reminder tick error')

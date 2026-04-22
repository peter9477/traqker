# Reminders

Traqker watches for common time-tracking slip-ups and sends a browser
notification when it spots one. This page explains what each reminder means
and when it fires.

## Quiet hours

Reminders are silenced from **11 pm to 8 am**. You will never be pinged
overnight, even if a condition is met.

## "Today" means your waking day, not the calendar day

When a reminder talks about "today," it means the day as you live it —
roughly from 6 am onward. A timer you started at 00:10 and stopped at 01:22
is treated as the tail end of *yesterday*, not the start of today. This
keeps late-night sessions from confusing the morning reminders.

## The five reminders

### 1. Timer still running (`running_late`)

**Fires:** when a timer you started on a weekday before 5 pm is still
running at or after 7 pm.

**What it catches:** you started a task in the morning or afternoon and
forgot to stop it at the end of the day.

Fires once per timer. If the timer is still running the next evening, you
get pinged again.

### 2. Timer running very late (`running_very_late`)

**Fires:** at or after 10 pm, for a timer that has been running for at
least 4 hours.

**What it catches:** the escalation for `running_late` — if 7 pm didn't
get your attention, 10 pm tries again, but only if the timer has actually
been going for a while (so a genuine evening task started at 9 pm won't
trigger it).

Example: a timer started at 09:00 and still running at 22:00 → fires
(13 hours running). A timer started at 21:00 and still running at 22:00 →
does **not** fire (only 1 hour — probably real work).

### 3. Runaway timer (`runaway`)

**Fires:** any time of day, on any day, as soon as a weekday-started timer
has been running for 8 hours or more.

**What it catches:** a timer left running overnight or across the weekend.
Unlike the "late" reminders, this one doesn't wait for evening — a timer
started Monday 09:00 that's still going at 17:00 will fire immediately.

Timers started on Saturday or Sunday don't trigger this rule (you probably
meant to track a long weekend session).

### 4. No timers started today (`no_activity`)

**Fires:** weekdays only, at noon, if you haven't started a single timer
today.

**What it catches:** you forgot to start tracking at the beginning of the
day.

Example: it's a Tuesday, 12:00, and you've been working since 9 but never
hit start → fires. An overnight session from 00:10 to 01:22 **does not**
count as "today's activity," so you'll still get the reminder at noon — the
rule wants to see real morning work, not the tail of last night.

### 5. Did you forget to start a timer? (`post_break_gap`)

**Fires:** weekdays only, when:
- no timer is currently running, AND
- you had at least one completed timer this morning (started between 6 am
  and noon), AND
- it's been at least 2 hours since your most recent stop, AND
- it's before 5 pm.

**What it catches:** the classic "came back from lunch and forgot to hit
start." You worked in the morning, took a break, and haven't resumed.

Examples:
- Worked 09:00–12:30, lunch, still nothing running at 14:45 → fires
  (2h 15m since the last stop).
- Worked 09:00–12:30, then nothing by 17:30 → does **not** fire. The 5 pm
  cutoff assumes you're probably done for the day, not still on a break.
- Worked 09:00–10:00, stopped, resumed 13:00–14:00, stopped, nothing by
  16:30 → fires (2h 30m since the 14:00 stop).
- Worked 00:10–01:22 (late last night), nothing yet at 10:00 → does **not**
  fire. That session isn't "this morning's work," so the rule has nothing
  to measure a gap from. `no_activity` will still fire at noon if you
  haven't started anything real by then.

## Why you might not see a reminder

- **Quiet hours** — before 8 am or after 11 pm, nothing fires.
- **Weekend** — `no_activity` and `post_break_gap` are weekday-only. The
  "timer still running" rules fire any day.
- **Already fired today** — each reminder fires at most once per calendar
  day. If you dismiss it and the condition stays true, it won't nag you
  again until tomorrow.
- **Browser notifications disabled** — reminders are sent by the server to
  every connected client, but each client decides locally whether to show
  a browser notification. Check your notification toggle in the app.

import { Connector, make_uuid, DEV, NO_RETRY } from './js/lib.js';

// ---------------------------------------------------------------------------
// Helpers

function ws_url() {
    return location.href.replace(/http(.*?:\/\/[^/]*)(\/[^/]*)(.*)/, 'ws$1$2.ws');
}

// Parse a local ISO string "YYYY-MM-DDTHH:MM:SS" as a local Date.
// JavaScript parses strings without a timezone suffix as LOCAL, which is
// what we want since Phase 0 stores local timestamps.
function parse_dt(s) {
    return new Date(s);
}

// "HH:MM" from a local ISO string
function fmt_time(s) {
    if (!s) return '';
    const d = parse_dt(s);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// "Mon Apr 7" from a Date
function fmt_day_label(d) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// "April 2026" from current_month "YYYY-MM"
function fmt_month_label(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

// "04/12" from "2026-04-12T..."
function fmt_mmdd(iso) {
    const [, m, d] = iso.slice(0, 10).split('-');
    return `${m}/${d}`;
}

// "1:30" from seconds
function fmt_duration(secs) {
    if (!secs || secs < 0) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

// "YYYY-MM-DD" from a Date (local)
function local_date_str(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

// "YYYY-MM-DDTHH:MM:SS" from Date+timeStr "HH:MM"
function build_local_iso(date_str, time_str) {
    const [hh, mm] = time_str.split(':');
    return `${date_str}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
}

// Given a start ISO string and an "HH:MM" time, return the ISO datetime that
// falls within the 24-hour window following start_iso.  If the naive same-day
// result would be at or before start_iso, advance by one calendar day.
function resolve_time_after(start_iso, time_str) {
    const candidate = build_local_iso(date_of(start_iso), time_str);
    if (candidate <= start_iso) {
        const d = new Date(date_of(start_iso) + 'T12:00:00');
        d.setDate(d.getDate() + 1);
        return build_local_iso(local_date_str(d), time_str);
    }
    return candidate;
}

// Which local date (YYYY-MM-DD) does an ISO string fall on?
function date_of(iso_str) {
    return local_date_str(parse_dt(iso_str));
}

// Monday of the week containing `d`
function week_start(d) {
    const day = new Date(d);
    const dow = (day.getDay() + 6) % 7; // Mon=0
    day.setDate(day.getDate() - dow);
    return day;
}

// Download text as a file
function download_text(filename, text) {
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
    a.download = filename;
    a.click();
}

// ---------------------------------------------------------------------------
// Entry duration helpers — accept explicit `now` (ms) so callers control
// whether the result is reactive/live or static.

function gross_secs(e, now) {
    const start = parse_dt(e.started_at).getTime();
    const end   = e.ended_at ? parse_dt(e.ended_at).getTime() : now;
    return Math.max(0, Math.floor((end - start) / 1000));
}

function break_secs(e, now) {
    let total = 0;
    for (const b of (e.breaks || [])) {
        if (!b.started_at) continue;
        const bs = parse_dt(b.started_at).getTime();
        const be = b.ended_at ? parse_dt(b.ended_at).getTime() : now;
        total += Math.max(0, Math.floor((be - bs) / 1000));
    }
    return total;
}

function net_secs(e, now) {
    return Math.max(0, gross_secs(e, now) - break_secs(e, now));
}

// ---------------------------------------------------------------------------
// Shared tick — a single module-scope reactive value advanced once a second
// by a single setInterval.  Any component that reads `live_now.t` will
// re-render on each tick; components that don't read it stay quiescent.
// This keeps live timer updates out of the root component's render path
// (so e.g. the project <select> isn't patched every second).

const live_now = Vue.reactive({ t: Date.now() });
setInterval(() => { live_now.t = Date.now(); }, 1000);

// LiveSecs — shows one entry's net duration live.

const LiveSecs = {
    props: ['entry'],
    computed: {
        net()  { return net_secs(this.entry, live_now.t); },
        gross(){ return gross_secs(this.entry, live_now.t); },
    },
    methods: { fmt_duration },
    template: `<span :title="'gross ' + fmt_duration(gross)">{{ fmt_duration(net) }}</span>`,
};

// LiveTotal — sums net durations for a list of entries, live.

const LiveTotal = {
    props: {
        entries:  { type: Array, default: () => [] },
        hideZero: { type: Boolean, default: false },
    },
    computed: {
        total() { return this.entries.reduce((s, e) => s + net_secs(e, live_now.t), 0); },
    },
    methods: { fmt_duration },
    template: `<span v-if="!hideZero || total">{{ fmt_duration(total) }}</span>`,
};

// ---------------------------------------------------------------------------
// v-focus directive: auto-focus an element when it appears

const vFocus = {
    mounted(el) { el.focus(); el.select && el.select(); }
};

// ---------------------------------------------------------------------------
// Vue app

const app = Vue.createApp({
    data() {
        const today = local_date_str(new Date());
        return {
            // Connection
            connected:       false,
            connState:       'connecting',
            updateAvailable: false,
            version:         '',
            hostname:        '',
            dev:             DEV,
            toasts:          [],

            // Core state (server-provided)
            today,
            person:   null,
            clients:  [],
            projects: [],
            tasks:    [],
            entries:  [],    // all loaded entries

            // View navigation
            view:         'day',          // 'day' | 'week' | 'month'
            current_date: today,          // YYYY-MM-DD — anchor for day/week/month
            current_month: today.slice(0, 7),  // YYYY-MM
            highlight_entry_id: null,     // briefly set after badge-click to flash the target entry
            badges_animate: false,        // true only during badge-click navigation; gates transition-group CSS

            // New-entry start form
            form: {
                project_id:  null,
                task_id:     null,
                description: '',
                billable:    true,
                // Manual entry (explicit start/end times)
                manual_open: false,
                start_time:  '',
                end_time:    '',
            },

            // Inline field editing
            editing:  null,   // {id, field, value, date_str, project_id?, task_id?}

            // Split-entry inline form
            splitting: null,  // {id, value}

            // Add-break inline form
            adding_break: null,  // {id, started_at, ended_at}

            // Two-step break delete
            pending_break_del: null,  // {id, bi}

            // Privacy
            show_private: false,

            // Admin panel
            show_admin: false,
            admin_tab:  'clients',
            admin_form: { name: '', notes: '', code: '', client_id: null,
                          project_id: null, billable_default: true },
            admin_editing: null,  // { kind, id, ...fields }
        };
    },

    mounted() {
        // Dark mode
        const savedDark = localStorage.getItem('darkMode');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (savedDark === 'true' || (savedDark === null && prefersDark))
            document.documentElement.classList.add('dark');

        // Connector
        this.conn = new Connector(this, { noRetry: NO_RETRY, giveUpMinutes: 120 });
        this.conn.addEventListener('state', e => {
            this.connState = e.state;
            this.connected = (e.state === 'connected');
        });
        this.conn.open(ws_url());

        // Keyboard shortcuts
        document.addEventListener('keydown', e => this.onKeydown(e));

        // Dev console helpers
        window.z = { vm: this, conn: this.conn, emit: (t, d) => this.conn.emit(t, d) };

        if (DEV) {
            less.env = 'development';
            less.poll = 2000;
            less.watch();
        }
    },

    beforeUnmount() {},

    computed: {
        // ---- entry queries -------------------------------------------------

        active_entries() {
            return this.entries
                .filter(e => e.ended_at === null)
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
        },

        running_elsewhere() {
            return this.active_entries.filter(e => {
                const d = date_of(e.started_at);
                if (this.view === 'day')   return d !== this.current_date;
                if (this.view === 'week')  return d < this.week_start_date || d > this.week_end_date;
                /* month */                return d.slice(0, 7) !== this.current_month;
            });
        },

        day_entries() {
            return this.entries
                .filter(e => date_of(e.started_at) === this.current_date)
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
        },

        billable_day_entries() {
            return this.day_entries.filter(e => e.billable);
        },

        billable_week_entries() {
            return this.week_entries.filter(e => e.billable);
        },

        billable_month_entries() {
            return this.month_entries.filter(e => e.billable);
        },

        // ---- project / task helpers ----------------------------------------

        active_projects() {
            return this.projects.filter(p => p.active);
        },

        form_tasks() {
            return this.tasks.filter(t =>
                t.active && (t.project_id === null || t.project_id === this.form.project_id)
            );
        },

        edit_tasks() {
            if (!this.editing) return [];
            const pid = this.editing.project_id;
            return this.tasks.filter(t =>
                t.active && (t.project_id === null || t.project_id === pid)
            );
        },

        // ---- week view -----------------------------------------------------

        week_days() {
            const anchor = new Date(this.current_date + 'T12:00:00');
            const mon = week_start(anchor);
            return Array.from({ length: 7 }, (_, i) => {
                const d = new Date(mon);
                d.setDate(d.getDate() + i);
                return { date: local_date_str(d), label: fmt_day_label(d), dom: d.getDate() };
            });
        },

        week_start_date() {
            return this.week_days[0].date;
        },

        week_end_date() {
            return this.week_days[6].date;
        },

        week_entries() {
            const start = this.week_start_date;
            const end   = this.week_end_date;
            return this.entries.filter(e => {
                const d = date_of(e.started_at);
                return d >= start && d <= end;
            });
        },

        // ---- month view ----------------------------------------------------

        month_weeks() {
            const [y, m] = this.current_month.split('-').map(Number);
            const first  = new Date(y, m - 1, 1);
            const last   = new Date(y, m, 0);
            // Grid starts on Monday before/of the 1st
            const startDow = (first.getDay() + 6) % 7;  // Mon=0
            const cells = [];
            // Pad with nulls before the 1st
            for (let i = 0; i < startDow; i++) cells.push(null);
            for (let d = 1; d <= last.getDate(); d++) {
                const date = new Date(y, m - 1, d);
                cells.push({ date: local_date_str(date), dom: d });
            }
            // Pad to full weeks
            while (cells.length % 7) cells.push(null);
            // Split into rows
            const weeks = [];
            for (let i = 0; i < cells.length; i += 7)
                weeks.push(cells.slice(i, i + 7));
            return weeks;
        },

        month_entries() {
            return this.entries.filter(e =>
                date_of(e.started_at).slice(0, 7) === this.current_month
            );
        },

        // ---- nav label -----------------------------------------------------

        navLabel() {
            if (this.view === 'day') {
                const d = new Date(this.current_date + 'T12:00:00');
                return fmt_day_label(d);
            }
            if (this.view === 'week') {
                return `${this.week_start_date} – ${this.week_end_date}`;
            }
            return fmt_month_label(this.current_month);
        },
    },

    methods: {

        // ================================================================
        // Server → client messages
        // ================================================================

        _msg_meta(msg) {
            if (msg.version)  this.version  = msg.version;
            if (msg.hostname) this.hostname = msg.hostname;
            if (msg.hash) {
                const key = 'traqker_hash';
                const old = sessionStorage[key] || localStorage[key] || null;
                sessionStorage[key] = localStorage[key] = msg.hash;
                if (old && old !== msg.hash) {
                    if (DEV) location.reload();
                    else this.updateAvailable = true;
                }
            }
        },

        _msg_state(msg) {
            this.today    = msg.today    || this.today;
            this.person   = msg.person   || this.person;
            this.clients  = msg.clients  || [];
            this.projects = msg.projects || [];
            this.tasks    = msg.tasks    || [];
            this.entries  = msg.entries  || [];
            // Initialise the current view's date from today
            this.current_date  = this.today;
            this.current_month = this.today.slice(0, 7);
            // Pre-populate form: prefer most recent ended entry, else a running one
            const ended  = this.entries.filter(e => e.ended_at !== null)
                               .sort((a, b) => b.ended_at.localeCompare(a.ended_at));
            const seed   = ended[0] || this.entries.filter(e => e.ended_at === null)
                               .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
            if (seed) {
                this.form.project_id = seed.project_id;
                this.form.task_id    = seed.task_id;
                this.onProjectChange();
            }
        },

        _msg_entries(msg) {
            // Merge loaded entries into this.entries, replacing by date range
            const start = msg.start_date;
            const end   = msg.end_date;
            // Remove old entries in the queried range (but keep others, e.g. running)
            this.entries = this.entries.filter(e => {
                const d = date_of(e.started_at);
                return d < start || d > end;
            });
            this.entries.push(...(msg.entries || []));
        },

        _msg_entry_update(msg) {
            const e = msg.entry;
            const idx = this.entries.findIndex(x => x.id === e.id);
            if (idx >= 0) this.entries[idx] = e;
            else this.entries.push(e);
        },

        _msg_entry_delete(msg) {
            this.entries = this.entries.filter(e => e.id !== msg.id);
        },

        _msg_entity_update(msg) {
            const { kind, item } = msg;
            const list = this[kind + 's'];  // 'client' → 'clients', etc.
            if (!list) return;
            const idx = list.findIndex(x => x.id === item.id);
            if (idx >= 0) list[idx] = item;
            else list.push(item);
        },

        _msg_entity_delete(msg) {
            const list = this[msg.kind + 's'];
            if (!list) return;
            const idx = list.findIndex(x => x.id === msg.id);
            if (idx >= 0) list.splice(idx, 1);
        },

        _msg_export_csv(msg) {
            download_text(msg.filename, msg.csv);
            this.toast(`Exported ${msg.filename}`, 'success');
        },

        _msg_error(msg) {
            this.toast(msg.text || 'Server error', 'danger');
        },

        // ================================================================
        // Entry calculations
        // ================================================================

        is_running(e) {
            return e.ended_at === null;
        },

        is_paused(e) {
            if (!this.is_running(e)) return false;
            const breaks = e.breaks || [];
            return breaks.length > 0 && breaks[breaks.length - 1].ended_at === null;
        },

        entry_gross_secs(e) { return gross_secs(e, Date.now()); },
        entry_break_secs(e) { return break_secs(e, Date.now()); },
        entry_net_secs(e)   { return net_secs(e, Date.now()); },
        break_duration(b) {
            if (!b.started_at) return '';
            const end = b.ended_at ? parse_dt(b.ended_at).getTime() : live_now.t;
            const secs = Math.max(0, Math.floor((end - parse_dt(b.started_at).getTime()) / 1000));
            return fmt_duration(secs);
        },

        // ================================================================
        // Display helpers
        // ================================================================

        fmt_time,
        fmt_duration,
        fmt_mmdd,
        date_of,

        is_private_entry(e) {
            const proj = this.projects.find(p => p.id === e.project_id);
            return proj && proj.name === 'Personal';
        },

        entry_label(e) {
            const proj = this.projects.find(p => p.id === e.project_id);
            const task = this.tasks.find(t => t.id === e.task_id);
            const parts = [];
            if (proj) parts.push(proj.name);
            if (task) parts.push(task.name);
            return parts.join(' › ');
        },

        project_name(id) {
            const p = this.projects.find(p => p.id === id);
            return p ? p.name : '';
        },

        client_name(id) {
            const c = this.clients.find(c => c.id === id);
            return c ? c.name : '';
        },

        client_prefix(proj) {
            if (!proj.client_id) return '';
            const c = this.clients.find(c => c.id === proj.client_id);
            return c ? c.name + ' › ' : '';
        },

        day_secs(date_str) {
            return this.entries
                .filter(e => date_of(e.started_at) === date_str)
                .reduce((s, e) => s + this.entry_net_secs(e), 0);
        },

        entries_for_day(date_str) {
            return this.entries
                .filter(e => date_of(e.started_at) === date_str)
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
        },

        // ================================================================
        // Start / stop / pause / resume
        // ================================================================

        onStart() {
            this.conn.emit('start_entry', {
                project_id:  this.form.project_id,
                task_id:     this.form.task_id,
                description: this.form.description,
                billable:    this.form.billable ? 1 : 0,
                travel:      0,
            });
            this.form.description = '';
        },

        onAdd() {
            const { start_time, end_time } = this.form;
            if (!start_time || !start_time.match(/^\d{1,2}:\d{2}$/)) {
                this.toast('Enter a valid start time HH:MM', 'warning');
                return;
            }
            if (!end_time || !end_time.match(/^\d{1,2}:\d{2}$/)) {
                this.toast('Enter a valid end time HH:MM', 'warning');
                return;
            }
            const started_at = build_local_iso(this.current_date, start_time);
            const ended_at   = resolve_time_after(started_at, end_time);
            this.conn.emit('create_entry', {
                started_at,
                ended_at,
                project_id:  this.form.project_id,
                task_id:     this.form.task_id,
                description: this.form.description,
                billable:    this.form.billable ? 1 : 0,
                travel:      0,
            });
            this.form.start_time  = '';
            this.form.end_time    = '';
            this.form.manual_open = false;
            this.form.description = '';
        },

        onStop(e) {
            this.conn.emit('stop_entry', { id: e.id });
        },

        onPause(e) {
            this.conn.emit('pause_entry', { id: e.id });
        },

        onResume(e) {
            this.conn.emit('resume_entry', { id: e.id });
        },

        onDelete(e) {
            if (!confirm(`Delete entry ${fmt_time(e.started_at)} – ${e.ended_at ? fmt_time(e.ended_at) : '…'}?`))
                return;
            this.conn.emit('delete_entry', { id: e.id });
        },

        onProjectChange() {
            // Auto-set billable from project default
            const proj = this.projects.find(p => p.id === this.form.project_id);
            if (proj) this.form.billable = !!proj.billable_default;
            // Clear task if it doesn't belong to the new project
            const task = this.tasks.find(t => t.id === this.form.task_id);
            if (task && task.project_id !== null && task.project_id !== this.form.project_id)
                this.form.task_id = null;
        },

        // ================================================================
        // Inline editing
        // ================================================================

        editField(e, field, break_index) {
            this.cancelEdit();
            if (field === 'project') {
                this.editing = {
                    id: e.id, field,
                    project_id: e.project_id,
                    task_id:    e.task_id,
                    value: '',
                };
            } else if (field === 'started_at') {
                this.editing = {
                    id: e.id, field,
                    date_str: date_of(e.started_at),
                    value: fmt_time(e.started_at),
                };
            } else if (field === 'ended_at') {
                this.editing = {
                    id: e.id, field,
                    date_str: date_of(e.started_at),
                    value: e.ended_at ? fmt_time(e.ended_at) : '',
                };
            } else if (field === 'break_start' || field === 'break_end') {
                const b = e.breaks[break_index];
                const t = (field === 'break_start') ? b.started_at : b.ended_at;
                this.editing = {
                    id: e.id, field, break_index,
                    value: t ? fmt_time(t) : '',
                };
            } else {
                this.editing = { id: e.id, field, value: e[field] || '' };
            }
        },

        saveEdit() {
            if (!this.editing) return;
            const { id, field, value, date_str, break_index } = this.editing;
            this.editing = null;

            if (field === 'break_start' || field === 'break_end') {
                if (!value || !value.match(/^\d{1,2}:\d{2}$/)) return;
                const entry = this.entries.find(x => x.id === id);
                if (!entry) return;
                const breaks = entry.breaks.map(b => ({ ...b }));
                const key = (field === 'break_start') ? 'started_at' : 'ended_at';
                breaks[break_index][key] = resolve_time_after(entry.started_at, value);
                this.conn.emit('update_entry', { id, breaks });
            } else if (field === 'started_at' || field === 'ended_at') {
                if (!value || !value.match(/^\d{1,2}:\d{2}$/)) return;
                let iso;
                if (field === 'ended_at') {
                    const entry = this.entries.find(e => e.id === id);
                    iso = entry ? resolve_time_after(entry.started_at, value)
                                : build_local_iso(date_str, value);
                } else {
                    iso = build_local_iso(date_str, value);
                }
                this.conn.emit('update_entry', { id, [field]: iso });
            } else if (field === 'description') {
                this.conn.emit('update_entry', { id, description: value });
            }
            // 'project' field is saved via saveProjectEdit
        },

        cancelEdit() {
            this.editing = null;
        },

        // Save when focus leaves the entire editing widget (not when it
        // moves between sibling inputs, e.g. date → time within started_at).
        onEditFocusOut(e) {
            if (!e.currentTarget.contains(e.relatedTarget)) {
                this.saveEdit();
            }
        },

        saveProjectEdit(e) {
            if (!this.editing) return;
            const { project_id, task_id } = this.editing;
            this.editing = null;
            const payload = { id: e.id, project_id, task_id };
            if (project_id !== e.project_id) {
                const proj = this.projects.find(p => p.id === project_id);
                if (proj) payload.billable = proj.billable_default ? 1 : 0;
            }
            this.conn.emit('update_entry', payload);
        },

        toggleBillable(e) {
            this.conn.emit('update_entry', { id: e.id, billable: e.billable ? 0 : 1 });
        },

        onEditProjectChange() {
            // Clear task when project changes in edit mode
            if (!this.editing) return;
            const task = this.tasks.find(t => t.id === this.editing.task_id);
            if (task && task.project_id !== null && task.project_id !== this.editing.project_id)
                this.editing.task_id = null;
        },

        // ================================================================
        // Break editing
        // ================================================================

        onDeleteBreak(e, bi) {
            const p = this.pending_break_del;
            if (p && p.id === e.id && p.bi === bi) {
                // Second click — confirmed.
                this.pending_break_del = null;
                if (this._break_del_timer) clearTimeout(this._break_del_timer);
                const breaks = e.breaks.filter((_, i) => i !== bi);
                this.conn.emit('update_entry', { id: e.id, breaks });
                return;
            }
            // First click — arm, then auto-disarm after 3s.
            this.pending_break_del = { id: e.id, bi };
            if (this._break_del_timer) clearTimeout(this._break_del_timer);
            this._break_del_timer = setTimeout(() => {
                this.pending_break_del = null;
                this._break_del_timer = null;
            }, 3000);
        },

        onAddBreakBegin(e) {
            this.splitting = null;
            this.adding_break = { id: e.id, started_at: '', ended_at: '' };
        },

        onAddBreakConfirm(e) {
            const { started_at, ended_at } = this.adding_break;
            this.adding_break = null;
            const rx = /^\d{1,2}:\d{2}$/;
            if (!started_at.match(rx) || !ended_at.match(rx)) {
                this.toast('Enter valid break times HH:MM', 'warning');
                return;
            }
            const bs = resolve_time_after(e.started_at, started_at);
            const be = resolve_time_after(bs, ended_at);
            if (e.ended_at && (bs >= e.ended_at || be > e.ended_at)) {
                this.toast('Break must be within the entry bounds.', 'warning');
                return;
            }
            const breaks = [...(e.breaks || []), { started_at: bs, ended_at: be }]
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
            this.conn.emit('update_entry', { id: e.id, breaks });
        },

        // ================================================================
        // Split
        // ================================================================

        onSplitBegin(e) {
            this.splitting = { id: e.id, value: '' };
        },

        onSplitConfirm(e) {
            const { value } = this.splitting;
            this.splitting = null;
            if (!value || !value.match(/^\d{1,2}:\d{2}$/)) {
                this.toast('Enter a valid time HH:MM', 'warning');
                return;
            }
            const split_at = resolve_time_after(e.started_at, value);
            if (split_at <= e.started_at || (e.ended_at && split_at >= e.ended_at)) {
                this.toast('Split time must be within the entry bounds.', 'warning');
                return;
            }
            this.conn.emit('split_entry', { id: e.id, split_at });
        },

        // ================================================================
        // Navigation
        // ================================================================

        switchView(v) {
            this.view = v;
            this._load_for_view();
        },

        navPrev() {
            this._nav_step(-1);
        },

        navNext() {
            this._nav_step(1);
        },

        navToday() {
            this.current_date  = this.today;
            this.current_month = this.today.slice(0, 7);
            this._load_for_view();
        },

        _nav_step(dir) {
            if (this.view === 'day') {
                const d = new Date(this.current_date + 'T12:00:00');
                d.setDate(d.getDate() + dir);
                this.current_date = local_date_str(d);
            } else if (this.view === 'week') {
                const d = new Date(this.current_date + 'T12:00:00');
                d.setDate(d.getDate() + dir * 7);
                this.current_date = local_date_str(d);
            } else {
                const [y, m] = this.current_month.split('-').map(Number);
                const nd = new Date(y, m - 1 + dir, 1);
                this.current_month = local_date_str(nd).slice(0, 7);
                this.current_date  = this.current_month + '-01';
            }
            this._load_for_view();
        },

        onBadgeBeforeLeave(el) {
            // Pin the leaving badge to its current position before it goes position:absolute,
            // otherwise it would snap to (0,0) of the container.
            el.style.left = el.offsetLeft + 'px';
            el.style.top  = el.offsetTop  + 'px';
            el.style.width = el.offsetWidth + 'px';
        },

        goToDay(date_str, highlight_id = null) {
            if (highlight_id != null) {
                this.badges_animate = true;
                // Cancel stale timers from a prior click so they can't kill this animation mid-flight
                clearTimeout(this._badges_animate_timer);
                clearTimeout(this._highlight_timer);
            }
            this.current_date = date_str;
            this.view = 'day';
            this._load_for_view();
            if (highlight_id != null) {
                this.$nextTick(() => {
                    this.highlight_entry_id = highlight_id;
                    this._highlight_timer = setTimeout(() => { this.highlight_entry_id = null; }, 900);
                    this._badges_animate_timer = setTimeout(() => { this.badges_animate = false; }, 3000);
                });
            }
        },

        _load_for_view() {
            if (this.view === 'day') {
                this._load_entries(this.current_date, this.current_date);
            } else if (this.view === 'week') {
                // week_days is computed, but current_date drives it
                const anchor = new Date(this.current_date + 'T12:00:00');
                const mon = week_start(anchor);
                const sun = new Date(mon);
                sun.setDate(sun.getDate() + 6);
                this._load_entries(local_date_str(mon), local_date_str(sun));
            } else {
                const [y, m] = this.current_month.split('-').map(Number);
                const first = local_date_str(new Date(y, m - 1, 1));
                const last  = local_date_str(new Date(y, m,   0));
                this._load_entries(first, last);
            }
        },

        _load_entries(start_date, end_date) {
            this.conn.emit('load_entries', { start_date, end_date });
        },

        // ================================================================
        // CSV export
        // ================================================================

        onExportDay() {
            this.conn.emit('export_csv', {
                start_date: this.current_date,
                end_date:   this.current_date,
            });
        },

        onExportWeek() {
            this.conn.emit('export_csv', {
                start_date: this.week_start_date,
                end_date:   this.week_end_date,
            });
        },

        onExportMonth() {
            const [y, m] = this.current_month.split('-').map(Number);
            this.conn.emit('export_csv', {
                start_date: local_date_str(new Date(y, m - 1, 1)),
                end_date:   local_date_str(new Date(y, m,   0)),
            });
        },

        // ================================================================
        // Entity management
        // ================================================================

        onCreateClient() {
            this.conn.emit('create_client', {
                name:  this.admin_form.name,
                notes: this.admin_form.notes || null,
            });
            this.admin_form = { ...this.admin_form, name: '', notes: '' };
        },

        onDeleteClient(c) {
            if (!confirm(`Delete client "${c.name}"?`)) return;
            this.conn.emit('delete_client', { id: c.id });
        },

        onCreateProject() {
            this.conn.emit('create_project', {
                name:             this.admin_form.name,
                code:             this.admin_form.code || null,
                client_id:        this.admin_form.client_id,
                billable_default: this.admin_form.billable_default ? 1 : 0,
            });
            this.admin_form = { ...this.admin_form, name: '', code: '', client_id: null, billable_default: true };
        },

        onDeleteProject(p) {
            if (!confirm(`Delete project "${p.name}"?`)) return;
            this.conn.emit('delete_project', { id: p.id });
        },

        onCreateTask() {
            this.conn.emit('create_task', {
                name:       this.admin_form.name,
                project_id: this.admin_form.project_id,
            });
            this.admin_form = { ...this.admin_form, name: '', project_id: null };
        },

        onDeleteTask(t) {
            if (!confirm(`Delete task "${t.name}"?`)) return;
            this.conn.emit('delete_task', { id: t.id });
        },

        onStartEdit(kind, item) {
            if (kind === 'client')  this.admin_editing = { kind, id: item.id, name: item.name, notes: item.notes || '' };
            if (kind === 'project') this.admin_editing = { kind, id: item.id, name: item.name, code: item.code || '',
                                                           client_id: item.client_id, billable_default: !!item.billable_default };
            if (kind === 'task')    this.admin_editing = { kind, id: item.id, name: item.name, project_id: item.project_id };
        },

        onCancelEdit() {
            this.admin_editing = null;
        },

        onSaveEdit() {
            const e = this.admin_editing;
            if (!e || !e.name.trim()) return;
            if (e.kind === 'client') {
                this.conn.emit('update_client',  { id: e.id, name: e.name.trim(), notes: e.notes || null });
            } else if (e.kind === 'project') {
                this.conn.emit('update_project', { id: e.id, name: e.name.trim(), code: e.code || null,
                                                   client_id: e.client_id, billable_default: e.billable_default ? 1 : 0 });
            } else if (e.kind === 'task') {
                this.conn.emit('update_task',    { id: e.id, name: e.name.trim(), project_id: e.project_id });
            }
            this.admin_editing = null;
        },

        // ================================================================
        // Keyboard shortcuts
        // ================================================================

        onKeydown(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'Escape') { this.cancelEdit(); this.splitting = null; this.adding_break = null; this.pending_break_del = null; }
        },

        // ================================================================
        // UI helpers
        // ================================================================

        reload() { location.reload(); },

        toggleDark() {
            const dark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('darkMode', dark);
        },

        toast(message, level = 'info', ms = 5000) {
            const id = make_uuid([2]);
            this.toasts.push({ id, message, level, fading: false });
            setTimeout(() => {
                const t = this.toasts.find(t => t.id === id);
                if (t) t.fading = true;
            }, ms);
            setTimeout(() => {
                this.toasts = this.toasts.filter(t => t.id !== id);
            }, ms + 900);
        },
    },
});

app.config.warnHandler = (msg) => console.warn('Vue:', msg);
app.directive('focus', vFocus);
app.component('live-secs',  LiveSecs);
app.component('live-total', LiveTotal);
app.mount('#vue-root');

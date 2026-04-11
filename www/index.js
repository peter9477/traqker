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

            // Live clock tick (for running timer display)
            now_ts: Date.now(),

            // New-entry start form
            form: {
                project_id:  null,
                task_id:     null,
                description: '',
                billable:    true,
                travel:      false,
                // Manual entry (explicit start/end times)
                manual_open: false,
                start_time:  '',
                end_time:    '',
            },

            // Inline field editing
            editing:  null,   // {id, field, value, date_str, project_id?, task_id?}

            // Split-entry inline form
            splitting: null,  // {id, value}

            // Admin panel
            show_admin: false,
            admin_tab:  'clients',
            admin_form: { name: '', notes: '', code: '', client_id: null,
                          project_id: null, billable_default: true },
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

        // Tick every second for live timer display
        this._tick = setInterval(() => { this.now_ts = Date.now(); }, 1000);

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

    beforeUnmount() {
        clearInterval(this._tick);
    },

    computed: {
        // ---- entry queries -------------------------------------------------

        active_entries() {
            return this.entries
                .filter(e => e.ended_at === null)
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
        },

        day_entries() {
            return this.entries
                .filter(e => date_of(e.started_at) === this.current_date)
                .sort((a, b) => a.started_at.localeCompare(b.started_at));
        },

        day_total_secs() {
            return this.day_entries.reduce((s, e) => s + this.entry_net_secs(e), 0);
        },

        day_billable_secs() {
            return this.day_entries
                .filter(e => e.billable)
                .reduce((s, e) => s + this.entry_net_secs(e), 0);
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

        week_total_secs() {
            return this.week_days.reduce((s, d) => s + this.day_secs(d.date), 0);
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

        month_total_secs() {
            return this.entries
                .filter(e => date_of(e.started_at).slice(0, 7) === this.current_month)
                .reduce((s, e) => s + this.entry_net_secs(e), 0);
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

        entry_gross_secs(e) {
            const start = parse_dt(e.started_at).getTime();
            const end   = e.ended_at ? parse_dt(e.ended_at).getTime() : this.now_ts;
            return Math.max(0, Math.floor((end - start) / 1000));
        },

        entry_break_secs(e) {
            let total = 0;
            for (const b of (e.breaks || [])) {
                if (!b.started_at) continue;
                const bs = parse_dt(b.started_at).getTime();
                const be = b.ended_at ? parse_dt(b.ended_at).getTime() : this.now_ts;
                total += Math.max(0, Math.floor((be - bs) / 1000));
            }
            return total;
        },

        entry_net_secs(e) {
            return Math.max(0, this.entry_gross_secs(e) - this.entry_break_secs(e));
        },

        // ================================================================
        // Display helpers
        // ================================================================

        fmt_time,
        fmt_duration,

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
                travel:      this.form.travel   ? 1 : 0,
            });
            this.form.description = '';
        },

        onAdd() {
            const { start_time, end_time } = this.form;
            if (!start_time || !start_time.match(/^\d{1,2}:\d{2}$/)) {
                this.toast('Enter a valid start time HH:MM', 'warning');
                return;
            }
            const started_at = build_local_iso(this.current_date, start_time);
            const ended_at = (end_time && end_time.match(/^\d{1,2}:\d{2}$/))
                ? resolve_time_after(started_at, end_time)
                : null;
            this.conn.emit('create_entry', {
                started_at,
                ended_at,
                project_id:  this.form.project_id,
                task_id:     this.form.task_id,
                description: this.form.description,
                billable:    this.form.billable ? 1 : 0,
                travel:      this.form.travel   ? 1 : 0,
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

        editField(e, field) {
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
            } else {
                this.editing = { id: e.id, field, value: e[field] || '' };
            }
        },

        saveEdit() {
            if (!this.editing) return;
            const { id, field, value, date_str } = this.editing;
            this.editing = null;

            if (field === 'started_at' || field === 'ended_at') {
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

        saveProjectEdit(e) {
            if (!this.editing) return;
            const { project_id, task_id } = this.editing;
            this.editing = null;
            this.conn.emit('update_entry', { id: e.id, project_id, task_id });
        },

        onEditProjectChange() {
            // Clear task when project changes in edit mode
            if (!this.editing) return;
            const task = this.tasks.find(t => t.id === this.editing.task_id);
            if (task && task.project_id !== null && task.project_id !== this.editing.project_id)
                this.editing.task_id = null;
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

        goToDay(date_str) {
            this.current_date = date_str;
            this.view = 'day';
            this._load_for_view();
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

        // ================================================================
        // Keyboard shortcuts
        // ================================================================

        onKeydown(e) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'Escape') { this.cancelEdit(); this.splitting = null; }
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
app.mount('#vue-root');

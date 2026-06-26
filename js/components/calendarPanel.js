import { calendarService, RECURRENCE_FREQUENCIES } from '../services/calendarService.js';
import { escapeHtml } from '../utils/markdown.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { toast } from './toast.js';

function inputDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatRange(event) {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    return `${start.toLocaleString([], { dateStyle: 'medium', timeStyle: event.allDay ? undefined : 'short' })} → ${end.toLocaleTimeString([], { timeStyle: 'short' })}`;
}

function ymd(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function download(name, text, type = 'text/calendar') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

class CalendarPanel {
    constructor() {
        this.opened = false;
        this.view = 'agenda';
        this.cursor = new Date();
        this.events = [];
        this.calendars = [];
        this.activeEventId = null;
        this.filters = { query: '' };
        this._saveTimer = null;
        this._renderShell();
        this._installExternalHooks();
    }

    isOpen() { return this.opened; }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'calendar-modal';
        modal.className = 'cal-modal';
        modal.innerHTML = `
            <div class="cal-overlay"></div>
            <div class="cal-panel">
                <header class="cal-header">
                    <div>
                        <h2><i data-lucide="calendar-days" class="icon"></i> Calendar</h2>
                        <p>Local-first scheduling for tasks, notes, email threads, agent proposals, reminders, and .ics handoff.</p>
                    </div>
                    <button id="cal-close" class="cal-close" type="button" aria-label="Close">&times;</button>
                </header>
                <div class="cal-body">
                    <aside class="cal-sidebar">
                        <form id="cal-quick-create" class="cal-quick-create">
                            <input id="cal-new-title" placeholder="New event title..." autocomplete="off">
                            <input id="cal-new-start" type="datetime-local">
                            <button class="cal-primary" type="submit"><i data-lucide="plus" class="icon"></i> Add</button>
                        </form>
                        <div class="cal-toolbar">
                            <input id="cal-search" type="search" placeholder="Search calendar..." autocomplete="off">
                            <div class="cal-view-buttons">
                                ${['agenda', 'day', 'week', 'month', 'list'].map(view => `<button type="button" data-view="${view}" class="${view === this.view ? 'active' : ''}">${view}</button>`).join('')}
                            </div>
                            <div class="cal-nav">
                                <button id="cal-prev" type="button">‹</button>
                                <button id="cal-today" type="button">Today</button>
                                <button id="cal-next" type="button">›</button>
                            </div>
                        </div>
                        <section class="cal-card cal-calendars">
                            <div class="cal-card-title"><strong>Calendars</strong><button id="cal-add-calendar" type="button">+</button></div>
                            <div id="cal-calendar-list"></div>
                        </section>
                        <section class="cal-card">
                            <div class="cal-card-title"><strong>Import / Export</strong></div>
                            <input id="cal-ics-file" type="file" accept=".ics,text/calendar">
                            <label>Conflict handling<select id="cal-conflict-mode"><option value="mark">Import and mark overlaps</option><option value="skip">Skip duplicates/overlaps</option></select></label>
                            <button id="cal-export-ics" type="button">Export visible .ics</button>
                        </section>
                        <section class="cal-card">
                            <div class="cal-card-title"><strong>CalDAV (optional)</strong></div>
                            <p class="cal-muted">V1 is local-only. Save server details here for a later explicit sync step.</p>
                            <input id="caldav-url" placeholder="CalDAV URL">
                            <input id="caldav-user" placeholder="Username">
                            <button id="caldav-save" type="button">Save placeholder</button>
                        </section>
                    </aside>
                    <main class="cal-main">
                        <div id="cal-view" class="cal-view"></div>
                        <section id="cal-editor" class="cal-editor-empty">Select or create an event.</section>
                    </main>
                </div>
            </div>`;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindShellEvents();
    }

    _bindShellEvents() {
        this.modal.querySelector('#cal-close').addEventListener('click', () => this.close());
        this.modal.querySelector('.cal-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#cal-quick-create').addEventListener('submit', e => this._quickCreate(e));
        this.modal.querySelector('#cal-search').addEventListener('input', e => { this.filters.query = e.target.value; this._load(); });
        this.modal.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', e => { this.view = e.currentTarget.dataset.view; this._load(); }));
        this.modal.querySelector('#cal-prev').addEventListener('click', () => this._shiftCursor(-1));
        this.modal.querySelector('#cal-next').addEventListener('click', () => this._shiftCursor(1));
        this.modal.querySelector('#cal-today').addEventListener('click', () => { this.cursor = new Date(); this._load(); });
        this.modal.querySelector('#cal-add-calendar').addEventListener('click', () => this._addCalendar());
        this.modal.querySelector('#cal-export-ics').addEventListener('click', () => this._exportIcs());
        this.modal.querySelector('#cal-ics-file').addEventListener('change', e => this._importIcs(e));
        this.modal.querySelector('#caldav-save').addEventListener('click', () => this._saveCaldavPlaceholder());
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.opened) this.close(); });
        eventBus.on(Events.CALENDAR_EVENT_SAVED, () => this.opened && this._load());
        eventBus.on(Events.CALENDAR_REMINDER_DUE, ({ event }) => toast.warning(`Reminder: ${event.title}`));
    }

    _installExternalHooks() {
        window.SynapseCalendar = {
            open: () => this.open(),
            createDraft: source => this.createDraftFromSource(source),
            suggestFromAgent: proposal => calendarService.suggestFromAgent(proposal)
        };
        window.addEventListener('synapse:calendarCreateDraft', e => this.createDraftFromSource(e.detail || {}));
        window.addEventListener('synapse:calendarAgentProposal', e => this._agentProposal(e.detail || {}));
    }

    async open() {
        this.opened = true;
        this.modal.classList.add('open');
        await calendarService.init();
        await this._load();
        refreshIcons();
    }

    close() {
        this.opened = false;
        this.modal.classList.remove('open');
    }

    _rangeForView() {
        const base = new Date(this.cursor);
        base.setHours(0, 0, 0, 0);
        if (this.view === 'day') return { from: base, to: addDays(base, 1) };
        if (this.view === 'week') {
            const start = addDays(base, -base.getDay());
            return { from: start, to: addDays(start, 7) };
        }
        if (this.view === 'month') {
            const start = new Date(base.getFullYear(), base.getMonth(), 1);
            return { from: start, to: new Date(base.getFullYear(), base.getMonth() + 1, 1) };
        }
        if (this.view === 'agenda') return { from: new Date(), to: addDays(new Date(), 14) };
        return { from: null, to: null };
    }

    async _load() {
        this.calendars = await calendarService.listCalendars({ includeDisabled: true });
        const range = this._rangeForView();
        this.events = await calendarService.listEvents({
            query: this.filters.query,
            from: range.from?.toISOString(),
            to: range.to?.toISOString()
        });
        this._renderCalendars();
        this._renderView();
        await this._renderEditor();
        refreshIcons();
    }

    _renderCalendars() {
        const box = this.modal.querySelector('#cal-calendar-list');
        box.innerHTML = this.calendars.map(calendar => `
            <label class="cal-calendar-row">
                <input data-calendar-toggle="${escapeHtml(calendar.id)}" type="checkbox" ${calendar.enabled ? 'checked' : ''}>
                <input data-calendar-color="${escapeHtml(calendar.id)}" type="color" value="${escapeHtml(calendar.color)}">
                <span>${escapeHtml(calendar.name)}</span>
            </label>`).join('');
        box.querySelectorAll('[data-calendar-toggle]').forEach(input => input.addEventListener('change', e => calendarService.saveCalendar({ id: e.target.dataset.calendarToggle, enabled: e.target.checked }).then(() => this._load())));
        box.querySelectorAll('[data-calendar-color]').forEach(input => input.addEventListener('input', e => calendarService.saveCalendar({ id: e.target.dataset.calendarColor, color: e.target.value }).then(() => this._load())));
    }

    _renderView() {
        this.modal.querySelectorAll('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === this.view));
        const view = this.modal.querySelector('#cal-view');
        const title = this.view === 'agenda' ? 'Upcoming agenda' : `${this.view[0].toUpperCase()}${this.view.slice(1)} view · ${this.cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}`;
        if (this.view === 'month') {
            const days = this._monthDays();
            view.innerHTML = `<div class="cal-view-title">${escapeHtml(title)}</div><div class="cal-month-grid">${days.map(day => this._dayCell(day)).join('')}</div>`;
        } else if (this.view === 'week') {
            const range = this._rangeForView();
            const days = Array.from({ length: 7 }, (_, i) => addDays(range.from, i));
            view.innerHTML = `<div class="cal-view-title">${escapeHtml(title)}</div><div class="cal-week-grid">${days.map(day => this._dayCell(day)).join('')}</div>`;
        } else if (this.view === 'day') {
            view.innerHTML = `<div class="cal-view-title">${escapeHtml(title)}</div><div class="cal-day-list">${this._eventsForDay(this.cursor).map(event => this._eventCard(event)).join('') || '<p class="cal-empty">No events today.</p>'}</div>`;
        } else {
            view.innerHTML = `<div class="cal-view-title">${escapeHtml(title)}</div><div class="cal-agenda-list">${this.events.map(event => this._eventCard(event)).join('') || '<p class="cal-empty">Nothing scheduled.</p>'}</div>`;
        }
        view.querySelectorAll('.cal-event-card').forEach(card => card.addEventListener('click', () => { this.activeEventId = card.dataset.id; this._renderView(); this._renderEditor(); }));
    }

    _monthDays() {
        const start = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
        const first = addDays(start, -start.getDay());
        return Array.from({ length: 42 }, (_, i) => addDays(first, i));
    }

    _dayCell(day) {
        const events = this._eventsForDay(day);
        return `<section class="cal-day-cell ${ymd(day) === ymd(new Date()) ? 'today' : ''}">
            <h4>${day.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</h4>
            ${events.slice(0, 4).map(event => this._eventPill(event)).join('')}${events.length > 4 ? `<small>+${events.length - 4} more</small>` : ''}
        </section>`;
    }

    _eventsForDay(day) {
        const key = ymd(day);
        return this.events.filter(event => ymd(event.startAt) === key);
    }

    _calendarFor(event) {
        return this.calendars.find(calendar => calendar.id === event.calendarId) || { color: '#7c3aed', name: 'Calendar' };
    }

    _eventPill(event) {
        const calendar = this._calendarFor(event);
        return `<button class="cal-event-pill cal-event-card ${event.id === this.activeEventId ? 'active' : ''}" data-id="${escapeHtml(event.id)}" style="--cal-color:${escapeHtml(calendar.color)}" type="button">${escapeHtml(event.title)}</button>`;
    }

    _eventCard(event) {
        const calendar = this._calendarFor(event);
        return `<article class="cal-event-card ${event.id === this.activeEventId ? 'active' : ''}" data-id="${escapeHtml(event.id)}" style="--cal-color:${escapeHtml(calendar.color)}">
            <strong>${event.approvalStatus === 'pending' ? '⏳ ' : ''}${escapeHtml(event.title)}</strong>
            <small>${escapeHtml(formatRange(event))}</small>
            <small>${escapeHtml(calendar.name)} · ${escapeHtml(event.sourceType)}${event.conflictOf ? ' · conflict' : ''}</small>
        </article>`;
    }

    async _renderEditor() {
        const editor = this.modal.querySelector('#cal-editor');
        const event = this.activeEventId ? await calendarService.getEvent(this.activeEventId) : null;
        if (!event) {
            editor.className = 'cal-editor-empty';
            editor.textContent = 'Select or create an event.';
            return;
        }
        editor.className = 'cal-editor';
        editor.innerHTML = `
            <div class="cal-editor-top">
                <input id="cal-title" value="${escapeHtml(event.title)}" placeholder="Title">
                <button id="cal-approve" type="button" ${event.approvalStatus === 'approved' ? 'disabled' : ''}>Approve</button>
                <button id="cal-delete" type="button">Delete</button>
            </div>
            <div class="cal-meta-grid">
                <label>Calendar<select id="cal-calendar">${this.calendars.map(calendar => `<option value="${escapeHtml(calendar.id)}" ${calendar.id === event.calendarId ? 'selected' : ''}>${escapeHtml(calendar.name)}</option>`).join('')}</select></label>
                <label>Start<input id="cal-start" type="datetime-local" value="${escapeHtml(inputDateTime(event.startAt))}"></label>
                <label>End<input id="cal-end" type="datetime-local" value="${escapeHtml(inputDateTime(event.endAt))}"></label>
                <label>Timezone<input id="cal-timezone" value="${escapeHtml(event.timezone)}"></label>
                <label>Recurrence<select id="cal-recurrence">${RECURRENCE_FREQUENCIES.map(freq => `<option value="${freq}" ${event.recurrence?.frequency === freq ? 'selected' : ''}>${freq}</option>`).join('')}</select></label>
                <label>Reminder minutes<input id="cal-reminder" type="number" min="0" value="${escapeHtml(event.reminders?.[0]?.minutesBefore ?? 15)}"></label>
                <label>Source<input id="cal-source" value="${escapeHtml(event.sourceType)}"></label>
                <label>Location<input id="cal-location" value="${escapeHtml(event.location || '')}"></label>
            </div>
            <textarea id="cal-description" placeholder="Description, agenda, links...">${escapeHtml(event.description || '')}</textarea>
            <section class="cal-linked-refs">
                <h3>Linked references</h3>
                ${(event.linkedRefs || []).map(ref => `<p><strong>${escapeHtml(ref.type)}</strong>: ${escapeHtml(ref.title)} ${ref.url ? `<a href="${escapeHtml(ref.url)}" target="_blank" rel="noreferrer">open</a>` : ''}</p>`).join('') || '<p class="cal-empty">No linked task/note/email references.</p>'}
            </section>`;
        this._bindEditorEvents(event);
    }

    _bindEditorEvents(event) {
        const save = () => this._scheduleSave(event.id, this._editorPatch());
        ['title', 'calendar', 'start', 'end', 'timezone', 'recurrence', 'reminder', 'source', 'location', 'description'].forEach(name => {
            const el = this.modal.querySelector(`#cal-${name}`);
            el?.addEventListener('input', save);
            el?.addEventListener('change', save);
        });
        this.modal.querySelector('#cal-approve')?.addEventListener('click', async () => { await calendarService.approveEvent(event.id); toast.success('Calendar proposal approved'); await this._load(); });
        this.modal.querySelector('#cal-delete')?.addEventListener('click', async () => { await calendarService.deleteEvent(event.id); this.activeEventId = null; toast.success('Event deleted'); await this._load(); });
    }

    _editorPatch() {
        return {
            title: this.modal.querySelector('#cal-title')?.value,
            calendarId: this.modal.querySelector('#cal-calendar')?.value,
            startAt: this.modal.querySelector('#cal-start')?.value,
            endAt: this.modal.querySelector('#cal-end')?.value,
            timezone: this.modal.querySelector('#cal-timezone')?.value,
            recurrence: { frequency: this.modal.querySelector('#cal-recurrence')?.value || 'none' },
            reminders: [{ minutesBefore: Number(this.modal.querySelector('#cal-reminder')?.value || 15), channels: ['in-app'], enabled: true }],
            sourceType: this.modal.querySelector('#cal-source')?.value || 'manual',
            location: this.modal.querySelector('#cal-location')?.value,
            description: this.modal.querySelector('#cal-description')?.value
        };
    }

    _scheduleSave(eventId, patch) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            try {
                await calendarService.saveEvent({ id: eventId, ...patch });
                await this._load();
            } catch (err) {
                console.error('[CalendarPanel] Save failed:', err);
                toast.error('Could not save event');
            }
        }, 350);
    }

    async _quickCreate(event) {
        event.preventDefault();
        const title = this.modal.querySelector('#cal-new-title').value.trim();
        if (!title) return;
        const start = this.modal.querySelector('#cal-new-start').value || new Date().toISOString();
        const end = new Date(start);
        end.setHours(end.getHours() + 1);
        const saved = await calendarService.saveEvent({ title, startAt: start, endAt: end.toISOString(), reminders: [{ minutesBefore: 15, channels: ['in-app'] }] });
        this.activeEventId = saved.id;
        this.modal.querySelector('#cal-new-title').value = '';
        toast.success('Event created');
        await this._load();
    }

    async createDraftFromSource(source = {}) {
        const saved = await calendarService.createFromSource(source, { approvalStatus: source.type === 'agent' ? 'pending' : 'approved' });
        this.activeEventId = saved.id;
        if (!this.opened) await this.open();
        else await this._load();
        toast.success('Scheduled from source');
        return saved;
    }

    async _agentProposal(proposal) {
        const saved = await calendarService.suggestFromAgent(proposal);
        this.activeEventId = saved.id;
        if (!this.opened) await this.open();
        else await this._load();
        toast.warning('Agent proposed a calendar event. Review and approve it.');
    }

    _shiftCursor(direction) {
        const step = this.view === 'day' ? 1 : this.view === 'week' ? 7 : 30;
        this.cursor = addDays(this.cursor, direction * step);
        this._load();
    }

    async _addCalendar() {
        const count = this.calendars.length + 1;
        await calendarService.saveCalendar({ name: `Calendar ${count}`, color: ['#7c3aed', '#ea580c', '#0891b2', '#16a34a'][count % 4] });
        await this._load();
    }

    async _exportIcs() {
        const ics = await calendarService.exportIcs({ query: this.filters.query });
        download(`synapse-calendar-${new Date().toISOString().slice(0, 10)}.ics`, ics);
    }

    async _importIcs(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        const conflictMode = this.modal.querySelector('#cal-conflict-mode').value;
        const result = await calendarService.importIcs(text, { conflictMode });
        toast.success(`Imported ${result.imported.length} events${result.conflicts.length ? ` (${result.conflicts.length} conflicts)` : ''}`);
        await this._load();
        event.target.value = '';
    }

    async _saveCaldavPlaceholder() {
        const primary = this.calendars[0] || { id: 'cal_personal' };
        await calendarService.saveCalendar({
            id: primary.id,
            caldav: {
                enabled: false,
                url: this.modal.querySelector('#caldav-url').value,
                username: this.modal.querySelector('#caldav-user').value,
                lastSyncAt: null
            }
        });
        toast.success('CalDAV placeholder saved (sync remains off)');
    }
}

export function createCalendarPanel() {
    return new CalendarPanel();
}

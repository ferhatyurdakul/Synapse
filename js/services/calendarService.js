import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';
import { eventBus, Events } from '../utils/eventBus.js';

const DEFAULT_CALENDARS = [
    { id: 'cal_personal', name: 'Personal', color: '#7c3aed', enabled: true, source: 'local' },
    { id: 'cal_work', name: 'Work', color: '#2563eb', enabled: true, source: 'local' },
    { id: 'cal_synapse', name: 'Synapse', color: '#059669', enabled: true, source: 'agent' }
];

const RECURRENCE_FREQUENCIES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const SOURCE_TYPES = ['manual', 'task', 'note', 'email', 'agent', 'import', 'caldav'];
const REMINDER_CHANNELS = ['in-app', 'browser', 'email', 'webhook'];

function now() {
    return new Date().toISOString();
}

function uid(prefix = 'calendar') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function toIsoLocalDateTime(value, fallback = null) {
    if (!value) return fallback;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return date.toISOString();
}

function dateOnly(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

function normalizeRecurrence(input = {}) {
    if (!input || input === 'none') return { frequency: 'none', interval: 1, until: null, count: null };
    if (typeof input === 'string') input = { frequency: input };
    const frequency = RECURRENCE_FREQUENCIES.includes(input.frequency) ? input.frequency : 'none';
    return {
        frequency,
        interval: Math.max(1, Number(input.interval || 1)),
        until: input.until || null,
        count: input.count ? Math.max(1, Number(input.count)) : null
    };
}

function normalizeReminder(input = {}) {
    if (!input && input !== 0) return [];
    const reminders = Array.isArray(input) ? input : [input];
    return reminders.map(reminder => {
        if (typeof reminder === 'number') return { minutesBefore: reminder, channels: ['in-app'], enabled: true };
        if (typeof reminder === 'string') return { at: reminder, minutesBefore: null, channels: ['in-app'], enabled: Boolean(reminder) };
        const channels = asArray(reminder.channels).filter(channel => REMINDER_CHANNELS.includes(channel));
        return {
            id: reminder.id || uid('rem'),
            at: reminder.at || null,
            minutesBefore: reminder.minutesBefore != null ? Number(reminder.minutesBefore) : 15,
            channels: channels.length ? channels : ['in-app'],
            enabled: reminder.enabled !== false
        };
    }).filter(Boolean);
}

function normalizeLinks(input = {}) {
    const refs = Array.isArray(input) ? input : [input].filter(Boolean);
    return refs.map(ref => typeof ref === 'string' ? { id: ref, title: ref } : ref)
        .filter(ref => ref && (ref.id || ref.title || ref.url))
        .map(ref => ({
            id: ref.id || uid('link'),
            type: ref.type || 'note',
            title: ref.title || ref.name || ref.url || ref.id,
            url: ref.url || '',
            excerpt: ref.excerpt || ref.body || ''
        }));
}

function normalizeCalendar(input = {}) {
    const timestamp = now();
    return {
        id: input.id || uid('cal'),
        name: String(input.name || 'New Calendar').trim(),
        color: input.color || '#7c3aed',
        enabled: input.enabled !== false,
        source: input.source || 'local',
        caldav: input.caldav || { enabled: false, url: '', username: '', lastSyncAt: null },
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function normalizeEvent(input = {}) {
    const timestamp = now();
    const start = toIsoLocalDateTime(input.startAt || input.start || input.date, timestamp);
    const endFallback = new Date(start);
    endFallback.setHours(endFallback.getHours() + 1);
    const end = toIsoLocalDateTime(input.endAt || input.end, endFallback.toISOString());
    const sourceType = SOURCE_TYPES.includes(input.sourceType) ? input.sourceType : (SOURCE_TYPES.includes(input.source?.type) ? input.source.type : 'manual');
    return {
        id: input.id || uid('evt'),
        calendarId: input.calendarId || 'cal_personal',
        title: String(input.title || 'Untitled Event').trim(),
        description: input.description || input.body || '',
        location: input.location || '',
        timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        startAt: start,
        endAt: end,
        allDay: Boolean(input.allDay),
        recurrence: normalizeRecurrence(input.recurrence),
        reminders: normalizeReminder(input.reminders || input.reminder),
        sourceType,
        source: input.source || { type: sourceType, title: input.sourceTitle || '' },
        linkedRefs: normalizeLinks(input.linkedRefs || input.links || input.sourceRefs),
        status: input.status || 'confirmed',
        approvalStatus: input.approvalStatus || (sourceType === 'agent' ? 'pending' : 'approved'),
        importFingerprint: input.importFingerprint || null,
        conflictOf: input.conflictOf || null,
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function eventSearchText(event) {
    return [event.title, event.description, event.location, event.sourceType, ...(event.linkedRefs || []).map(ref => ref.title)].join(' ').toLowerCase();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

function unfoldIcs(text) {
    return String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function parseIcsDate(value) {
    if (!value) return null;
    if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`;
    const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${value.endsWith('Z') ? 'Z' : ''}`).toISOString();
}

function escapeIcs(value = '') {
    return String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function icsDate(value) {
    return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

class CalendarService {
    constructor() {
        this._reminderTimer = null;
        this._firedReminders = new Set();
    }

    async init() {
        await this.ensureDefaultCalendars();
        this.startReminderLoop();
    }

    async ensureDefaultCalendars() {
        const existing = await getAllRecords('calendars');
        if (existing.length) return existing;
        const calendars = DEFAULT_CALENDARS.map(normalizeCalendar);
        for (const calendar of calendars) await putRecord('calendars', calendar);
        return calendars;
    }

    async listCalendars({ includeDisabled = true } = {}) {
        await this.ensureDefaultCalendars();
        const calendars = await getAllRecords('calendars');
        return calendars.filter(calendar => includeDisabled || calendar.enabled).sort((a, b) => a.name.localeCompare(b.name));
    }

    async saveCalendar(input) {
        const existing = input.id ? await getRecord('calendars', input.id) : null;
        const calendar = normalizeCalendar({ ...existing, ...input, id: input.id || existing?.id, createdAt: existing?.createdAt });
        await putRecord('calendars', calendar);
        eventBus.emit(Events.CALENDAR_UPDATED, calendar);
        return calendar;
    }

    async deleteCalendar(calendarId) {
        if (DEFAULT_CALENDARS.some(calendar => calendar.id === calendarId)) {
            return this.saveCalendar({ id: calendarId, enabled: false });
        }
        await deleteRecord('calendars', calendarId);
        eventBus.emit(Events.CALENDAR_UPDATED, { id: calendarId, deleted: true });
    }

    async listEvents(filters = {}) {
        await this.ensureDefaultCalendars();
        const calendars = await this.listCalendars({ includeDisabled: false });
        const enabledIds = new Set(calendars.map(calendar => calendar.id));
        const query = String(filters.query || '').trim().toLowerCase();
        let events = await getAllRecords('calendarEvents');
        events = events.filter(event => filters.includeDisabledCalendars || enabledIds.has(event.calendarId));
        if (filters.calendarId) events = events.filter(event => event.calendarId === filters.calendarId);
        if (filters.sourceType) events = events.filter(event => event.sourceType === filters.sourceType);
        if (filters.approvalStatus) events = events.filter(event => event.approvalStatus === filters.approvalStatus);
        if (filters.from) events = events.filter(event => new Date(event.endAt) >= new Date(filters.from));
        if (filters.to) events = events.filter(event => new Date(event.startAt) <= new Date(filters.to));
        if (query) events = events.filter(event => eventSearchText(event).includes(query));
        events.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
        return events;
    }

    async getEvent(eventId) {
        return getRecord('calendarEvents', eventId);
    }

    async saveEvent(input = {}) {
        const existing = input.id ? await this.getEvent(input.id) : null;
        const event = normalizeEvent({ ...existing, ...input, id: input.id || existing?.id, createdAt: existing?.createdAt });
        await putRecord('calendarEvents', event);
        eventBus.emit(Events.CALENDAR_EVENT_SAVED, event);
        return event;
    }

    async deleteEvent(eventId) {
        await deleteRecord('calendarEvents', eventId);
        eventBus.emit(Events.CALENDAR_EVENT_DELETED, { id: eventId });
    }

    async createFromSource(source = {}, overrides = {}) {
        const sourceType = SOURCE_TYPES.includes(source.type) ? source.type : (source.kind || 'manual');
        const title = overrides.title || source.title || source.subject || 'Scheduled Item';
        const body = overrides.description || source.body || source.excerpt || source.summary || '';
        const date = overrides.startAt || source.dueAt || source.startAt || source.date || new Date().toISOString();
        const linkedRefs = [{
            id: source.id || source.url || uid('source'),
            type: sourceType,
            title,
            url: source.url || '',
            excerpt: body
        }];
        return this.saveEvent({
            title,
            description: body,
            startAt: date,
            endAt: overrides.endAt,
            sourceType,
            source: { type: sourceType, id: source.id || '', title },
            linkedRefs,
            approvalStatus: sourceType === 'agent' ? 'pending' : 'approved',
            ...overrides
        });
    }

    async suggestFromAgent(proposal = {}) {
        return this.createFromSource({ ...proposal, type: 'agent' }, { ...proposal, approvalStatus: 'pending' });
    }

    async approveEvent(eventId) {
        return this.saveEvent({ id: eventId, approvalStatus: 'approved' });
    }

    async findConflicts(candidate) {
        const normalized = normalizeEvent(candidate);
        const events = await this.listEvents({ from: normalized.startAt, to: normalized.endAt, includeDisabledCalendars: true });
        return events.filter(event => event.id !== normalized.id && rangesOverlap(event.startAt, event.endAt, normalized.startAt, normalized.endAt));
    }

    async importIcs(text, { calendarId = 'cal_personal', conflictMode = 'mark' } = {}) {
        const lines = unfoldIcs(text);
        const imported = [];
        const conflicts = [];
        let current = null;
        for (const line of lines) {
            if (line === 'BEGIN:VEVENT') current = {};
            else if (line === 'END:VEVENT' && current) {
                const event = normalizeEvent({
                    calendarId,
                    title: current.SUMMARY || 'Imported Event',
                    description: current.DESCRIPTION || '',
                    location: current.LOCATION || '',
                    startAt: parseIcsDate(current.DTSTART),
                    endAt: parseIcsDate(current.DTEND),
                    sourceType: 'import',
                    importFingerprint: current.UID || `${current.SUMMARY}|${current.DTSTART}`,
                    approvalStatus: 'approved'
                });
                const existing = (await this.listEvents({ includeDisabledCalendars: true })).find(item => item.importFingerprint === event.importFingerprint);
                const eventConflicts = await this.findConflicts(event);
                if (existing && conflictMode === 'skip') {
                    conflicts.push({ event, reason: 'duplicate', existing });
                } else if (eventConflicts.length && conflictMode === 'skip') {
                    conflicts.push({ event, reason: 'time-overlap', conflicts: eventConflicts });
                } else {
                    const saved = await this.saveEvent({ ...event, id: existing?.id, conflictOf: eventConflicts[0]?.id || null });
                    imported.push(saved);
                    if (eventConflicts.length) conflicts.push({ event: saved, reason: 'time-overlap', conflicts: eventConflicts });
                }
                current = null;
            } else if (current) {
                const idx = line.indexOf(':');
                if (idx > -1) {
                    const key = line.slice(0, idx).split(';')[0].toUpperCase();
                    current[key] = line.slice(idx + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
                }
            }
        }
        return { imported, conflicts };
    }

    async exportIcs(filters = {}) {
        const events = await this.listEvents(filters);
        return [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Synapse//Calendar V1//EN',
            ...events.flatMap(event => [
                'BEGIN:VEVENT',
                `UID:${event.importFingerprint || event.id}@synapse.local`,
                `DTSTAMP:${icsDate(event.updatedAt || now())}`,
                `DTSTART:${icsDate(event.startAt)}`,
                `DTEND:${icsDate(event.endAt)}`,
                `SUMMARY:${escapeIcs(event.title)}`,
                event.description ? `DESCRIPTION:${escapeIcs(event.description)}` : '',
                event.location ? `LOCATION:${escapeIcs(event.location)}` : '',
                event.recurrence?.frequency && event.recurrence.frequency !== 'none' ? `RRULE:FREQ=${event.recurrence.frequency.toUpperCase()};INTERVAL=${event.recurrence.interval || 1}` : '',
                'END:VEVENT'
            ].filter(Boolean)),
            'END:VCALENDAR'
        ].join('\r\n');
    }

    upcomingAgenda(days = 14) {
        const from = new Date();
        const to = new Date();
        to.setDate(to.getDate() + days);
        return this.listEvents({ from: from.toISOString(), to: to.toISOString() });
    }

    startReminderLoop() {
        if (this._reminderTimer) return;
        const tick = async () => {
            const nowMs = Date.now();
            const horizon = new Date(nowMs + 60 * 60 * 1000).toISOString();
            const events = await this.listEvents({ from: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(), to: horizon }).catch(() => []);
            for (const event of events) {
                for (const reminder of event.reminders || []) {
                    if (!reminder.enabled) continue;
                    const remindAt = reminder.at ? new Date(reminder.at) : new Date(new Date(event.startAt).getTime() - (reminder.minutesBefore || 0) * 60000);
                    const key = `${event.id}:${reminder.id || reminder.minutesBefore || reminder.at}`;
                    if (remindAt.getTime() <= nowMs && remindAt.getTime() > nowMs - 5 * 60000 && !this._firedReminders.has(key)) {
                        this._firedReminders.add(key);
                        eventBus.emit(Events.CALENDAR_REMINDER_DUE, { event, reminder });
                        window.dispatchEvent(new CustomEvent('synapse:calendarReminderDue', { detail: { event, reminder } }));
                    }
                }
            }
        };
        tick();
        this._reminderTimer = setInterval(tick, 60000);
    }

    stopReminderLoop() {
        clearInterval(this._reminderTimer);
        this._reminderTimer = null;
    }

    dateOnly(value) { return dateOnly(value); }
}

export const calendarService = new CalendarService();
export { RECURRENCE_FREQUENCIES, SOURCE_TYPES, REMINDER_CHANNELS };

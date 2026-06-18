import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';

const ITEM_TYPES = ['note', 'task'];
const TASK_STATUSES = ['inbox', 'next', 'in-progress', 'waiting', 'scheduled', 'done', 'archived'];
const NOTE_STATUSES = ['draft', 'active', 'review', 'archived'];
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const SOURCE_TYPES = ['manual', 'chat', 'research', 'email', 'document', 'web', 'agent'];
const REMINDER_CHANNELS = ['in-app', 'browser', 'email', 'webhook', 'ntfy'];

function now() {
    return new Date().toISOString();
}

function id(prefix = 'work') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseList(value) {
    if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeChecklist(items = []) {
    if (typeof items === 'string') {
        items = items.split('\n').map(text => ({ text: text.replace(/^[-*]\s*/, '').trim() })).filter(item => item.text);
    }
    if (!Array.isArray(items)) return [];
    return items.map(item => typeof item === 'string' ? { text: item } : item)
        .filter(item => String(item.text || '').trim())
        .map(item => ({
            id: item.id || id('check'),
            text: String(item.text || '').trim(),
            done: Boolean(item.done),
            createdAt: item.createdAt || now(),
            completedAt: item.done ? (item.completedAt || now()) : null
        }));
}

function normalizeSourceRefs(value = []) {
    const refs = Array.isArray(value) ? value : [value].filter(Boolean);
    return refs.map(ref => typeof ref === 'string' ? { id: ref } : ref)
        .filter(ref => ref && (ref.id || ref.title || ref.url || ref.excerpt))
        .map(ref => ({
            id: ref.id || id('src'),
            type: SOURCE_TYPES.includes(ref.type) ? ref.type : 'manual',
            title: ref.title || ref.url || ref.id || 'Source',
            url: ref.url || '',
            excerpt: ref.excerpt || ref.text || '',
            createdAt: ref.createdAt || now()
        }));
}

function normalizeReminder(input = {}) {
    if (!input && input !== 0) return null;
    if (typeof input === 'string') return { at: input, channels: ['in-app'], enabled: Boolean(input) };
    return {
        at: input.at || input.date || null,
        channels: parseList(input.channels).filter(channel => REMINDER_CHANNELS.includes(channel)),
        enabled: input.enabled !== false && Boolean(input.at || input.date)
    };
}

function normalizeRecurrence(input = {}) {
    if (!input || input === 'none') return { frequency: 'none', interval: 1 };
    if (typeof input === 'string') return { frequency: input, interval: 1 };
    return {
        frequency: input.frequency || 'none',
        interval: Math.max(1, Number(input.interval || 1)),
        until: input.until || null,
        nextDueAt: input.nextDueAt || null
    };
}

function normalizeItem(input = {}) {
    const timestamp = now();
    const type = ITEM_TYPES.includes(input.type) ? input.type : 'task';
    const statuses = type === 'task' ? TASK_STATUSES : NOTE_STATUSES;
    const status = statuses.includes(input.status) ? input.status : (type === 'task' ? 'inbox' : 'draft');
    return {
        id: input.id || id(type),
        type,
        title: String(input.title || (type === 'task' ? 'Untitled Task' : 'Untitled Note')).trim(),
        body: input.body || input.content || '',
        status,
        priority: PRIORITIES.includes(input.priority) ? input.priority : 'none',
        dueAt: input.dueAt || input.dueDate || null,
        startAt: input.startAt || input.startDate || null,
        reminder: normalizeReminder(input.reminder || input.reminderAt),
        recurrence: normalizeRecurrence(input.recurrence),
        tags: parseList(input.tags),
        links: parseList(input.links),
        checklist: normalizeChecklist(input.checklist || input.checklistItems),
        sourceRefs: normalizeSourceRefs(input.sourceRefs || input.sources || input.source),
        projectId: input.projectId || input.project || 'default',
        listId: input.listId || input.list || 'inbox',
        pinned: Boolean(input.pinned),
        favorite: Boolean(input.favorite),
        archived: Boolean(input.archived) || status === 'archived',
        agentRunnable: Boolean(input.agentRunnable),
        agentRunHook: input.agentRunHook || null,
        aiState: input.aiState || { lastSummary: '', extractedDeadlines: [], proposedActions: [] },
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp,
        completedAt: status === 'done' ? (input.completedAt || timestamp) : (input.completedAt || null)
    };
}

function searchText(item) {
    return [
        item.title,
        item.body,
        item.type,
        item.status,
        item.priority,
        item.projectId,
        item.listId,
        ...(item.tags || []),
        ...(item.links || []),
        ...(item.checklist || []).map(check => check.text),
        ...(item.sourceRefs || []).flatMap(ref => [ref.type, ref.title, ref.url, ref.excerpt])
    ].join(' ').toLowerCase();
}

function isOverdue(item, today = new Date()) {
    if (!item.dueAt || ['done', 'archived'].includes(item.status)) return false;
    const due = new Date(item.dueAt);
    due.setHours(23, 59, 59, 999);
    return due < today;
}

function isUpcoming(item, today = new Date()) {
    if (!item.dueAt || ['done', 'archived'].includes(item.status)) return false;
    const due = new Date(item.dueAt);
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 7);
    return due >= today && due <= horizon;
}

class NotesTaskService {
    listTypes() { return ITEM_TYPES; }
    listStatuses(type = 'task') { return type === 'note' ? NOTE_STATUSES : TASK_STATUSES; }
    listPriorities() { return PRIORITIES; }
    listReminderChannels() { return REMINDER_CHANNELS; }

    async list(filters = {}) {
        let items = await getAllRecords('workItems');
        const query = String(filters.query || '').trim().toLowerCase();
        const includeArchived = Boolean(filters.includeArchived);

        items = items.filter(item => includeArchived || !item.archived);
        if (filters.type) items = items.filter(item => item.type === filters.type);
        if (filters.status) items = items.filter(item => item.status === filters.status);
        if (filters.priority) items = items.filter(item => item.priority === filters.priority);
        if (filters.projectId) items = items.filter(item => item.projectId === filters.projectId);
        if (filters.listId) items = items.filter(item => item.listId === filters.listId);
        if (filters.tag) items = items.filter(item => (item.tags || []).includes(filters.tag));
        if (filters.pinned) items = items.filter(item => item.pinned);
        if (filters.favorite) items = items.filter(item => item.favorite);
        if (filters.overdue) items = items.filter(item => isOverdue(item));
        if (filters.upcoming) items = items.filter(item => isUpcoming(item));
        if (query) items = items.filter(item => searchText(item).includes(query));

        items.sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            const dueCompare = String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'));
            if (dueCompare !== 0) return dueCompare;
            return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        });
        return items;
    }

    async get(itemId) {
        return getRecord('workItems', itemId);
    }

    async save(input = {}) {
        const item = normalizeItem(input);
        await putRecord('workItems', item);
        await this._upsertRagShadow(item);
        return item;
    }

    async update(itemId, patch = {}) {
        const existing = await this.get(itemId);
        if (!existing) throw new Error(`Work item not found: ${itemId}`);
        const item = normalizeItem({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt });
        await putRecord('workItems', item);
        await this._upsertRagShadow(item);
        return item;
    }

    async delete(itemId) {
        await deleteRecord('workItems', itemId);
    }

    async archive(itemId, archived = true) {
        const item = await this.get(itemId);
        return this.update(itemId, { archived, status: archived ? 'archived' : (item?.type === 'note' ? 'active' : 'inbox') });
    }

    async toggleChecklist(itemId, checklistId) {
        const item = await this.get(itemId);
        if (!item) throw new Error(`Work item not found: ${itemId}`);
        const checklist = (item.checklist || []).map(check => check.id === checklistId
            ? { ...check, done: !check.done, completedAt: !check.done ? now() : null }
            : check);
        return this.update(itemId, { checklist });
    }

    async batchUpdate(itemIds = [], patch = {}) {
        const updated = [];
        for (const itemId of itemIds) {
            updated.push(await this.update(itemId, patch));
        }
        return updated;
    }

    async convertFromSource(source = {}, overrides = {}) {
        const type = overrides.type || source.targetType || (source.kind === 'note' ? 'note' : 'task');
        const sourceType = SOURCE_TYPES.includes(source.type) ? source.type : (source.kind || 'manual');
        return this.save({
            type,
            title: overrides.title || source.title || source.subject || 'Captured Work Item',
            body: overrides.body || source.body || source.content || source.excerpt || '',
            tags: overrides.tags || source.tags,
            projectId: overrides.projectId || source.projectId,
            listId: overrides.listId || source.listId,
            dueAt: overrides.dueAt || source.dueAt,
            priority: overrides.priority || source.priority,
            checklist: overrides.checklist || source.checklist,
            sourceRefs: [{
                id: source.id || source.chatId || source.runId || source.documentId || id('src'),
                type: sourceType,
                title: source.title || source.subject || source.url || sourceType,
                url: source.url || '',
                excerpt: source.excerpt || source.body || source.content || ''
            }]
        });
    }

    async makeAiSuggestion(itemId, kind = 'next-actions') {
        const item = await this.get(itemId);
        if (!item) throw new Error(`Work item not found: ${itemId}`);
        const body = item.body || '';
        const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
        if (kind === 'task-list') {
            return {
                kind,
                title: 'Draft task list',
                content: lines.slice(0, 8).map(line => `- [ ] ${line.replace(/^[-*]\s*/, '')}`).join('\n') || `- [ ] Clarify next step for ${item.title}`,
                createdAt: now()
            };
        }
        if (kind === 'deadlines') {
            const deadlineHints = [item.dueAt, ...lines.filter(line => /due|deadline|by\s+\w+/i.test(line))].filter(Boolean);
            return { kind, title: 'Extracted deadlines', content: deadlineHints.join('\n') || 'No explicit deadline found.', createdAt: now() };
        }
        if (kind === 'summary') {
            return { kind, title: 'Task state summary', content: `${item.status} · ${item.priority} · ${(item.checklist || []).filter(c => c.done).length}/${(item.checklist || []).length} checklist items done.`, createdAt: now() };
        }
        return { kind: 'next-actions', title: 'Proposed next actions', content: `- Review ${item.title}\n- Pick one concrete next action\n- Set a due date or reminder`, createdAt: now() };
    }

    async _upsertRagShadow(item) {
        try {
            const collectionId = 'work-item-library';
            await putRecord('ragCollections', { id: collectionId, name: 'Notes and Tasks Workspace', createdAt: item.createdAt, updatedAt: item.updatedAt });
            await putRecord('ragDocuments', {
                id: `work:${item.id}`,
                collectionId,
                title: item.title,
                content: this.toMarkdown(item),
                metadata: { source: 'notes-tasks-workspace', type: item.type, status: item.status, tags: item.tags, projectId: item.projectId },
                createdAt: item.createdAt,
                updatedAt: item.updatedAt
            });
        } catch (err) {
            console.warn('[NotesTaskService] RAG shadow update skipped:', err);
        }
    }

    toMarkdown(item) {
        const checklist = (item.checklist || []).map(check => `- [${check.done ? 'x' : ' '}] ${check.text}`).join('\n') || 'No checklist items.';
        const refs = (item.sourceRefs || []).map(ref => `- ${ref.type}: ${ref.title}${ref.url ? ` (${ref.url})` : ''}`).join('\n') || 'No source refs.';
        return `# ${item.title}\n\n- Type: ${item.type}\n- Status: ${item.status}\n- Priority: ${item.priority}\n- Project: ${item.projectId}\n- List: ${item.listId}\n- Due: ${item.dueAt || 'none'}\n- Start: ${item.startAt || 'none'}\n- Tags: ${(item.tags || []).join(', ') || 'none'}\n\n${item.body || ''}\n\n## Checklist\n${checklist}\n\n## Sources\n${refs}\n`;
    }
}

export const notesTaskService = new NotesTaskService();
export { ITEM_TYPES, TASK_STATUSES, NOTE_STATUSES, PRIORITIES, REMINDER_CHANNELS };

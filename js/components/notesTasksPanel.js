import { notesTaskService, TASK_STATUSES, NOTE_STATUSES, PRIORITIES } from '../services/notesTaskService.js';
import { escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

function optionList(values, selected) {
    return values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}

function formatDate(value) {
    if (!value) return '';
    return new Date(value).toLocaleDateString();
}

function dateInput(value) {
    return value ? String(value).slice(0, 10) : '';
}

class NotesTasksPanel {
    constructor() {
        this.opened = false;
        this.items = [];
        this.activeId = null;
        this.selected = new Set();
        this.filters = { query: '', type: '', status: '', includeArchived: false };
        this._saveTimer = null;
        this._renderShell();
    }

    isOpen() {
        return this.opened;
    }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'notes-tasks-modal';
        modal.className = 'nt-modal';
        modal.innerHTML = `
            <div class="nt-overlay"></div>
            <div class="nt-panel">
                <header class="nt-header">
                    <div>
                        <h2><i data-lucide="check-square" class="icon"></i> Notes & Tasks</h2>
                        <p>Quick capture, actionable notes, due dates, checklists, pins, reminders, and source-linked work.</p>
                    </div>
                    <button id="nt-close" class="nt-close" type="button">&times;</button>
                </header>
                <div class="nt-body">
                    <aside class="nt-sidebar">
                        <form id="nt-capture" class="nt-capture">
                            <select id="nt-new-type"><option value="task">Task</option><option value="note">Note</option></select>
                            <input id="nt-new-title" placeholder="Quick capture..." autocomplete="off">
                            <button class="nt-primary" type="submit"><i data-lucide="plus" class="icon"></i> Capture</button>
                        </form>
                        <div class="nt-toolbar">
                            <input id="nt-search" type="search" placeholder="Search work..." autocomplete="off">
                            <select id="nt-type-filter"><option value="">All types</option><option value="task">Tasks</option><option value="note">Notes</option></select>
                            <select id="nt-status-filter"><option value="">All statuses</option>${optionList([...new Set([...TASK_STATUSES, ...NOTE_STATUSES])], '')}</select>
                            <label><input id="nt-archived-filter" type="checkbox"> Archived</label>
                        </div>
                        <div class="nt-batch">
                            <button id="nt-batch-done" type="button">Mark done</button>
                            <button id="nt-batch-archive" type="button">Archive</button>
                            <span id="nt-selected-count">0 selected</span>
                        </div>
                        <div id="nt-lanes" class="nt-lanes"></div>
                    </aside>
                    <section id="nt-editor" class="nt-editor-empty">Select or capture an item to start.</section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindShellEvents();
    }

    _bindShellEvents() {
        this.modal.querySelector('#nt-close').addEventListener('click', () => this.close());
        this.modal.querySelector('.nt-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#nt-capture').addEventListener('submit', e => this._capture(e));
        this.modal.querySelector('#nt-search').addEventListener('input', e => { this.filters.query = e.target.value; this._load(); });
        this.modal.querySelector('#nt-type-filter').addEventListener('change', e => { this.filters.type = e.target.value; this._load(); });
        this.modal.querySelector('#nt-status-filter').addEventListener('change', e => { this.filters.status = e.target.value; this._load(); });
        this.modal.querySelector('#nt-archived-filter').addEventListener('change', e => { this.filters.includeArchived = e.target.checked; this._load(); });
        this.modal.querySelector('#nt-batch-done').addEventListener('click', () => this._batch({ status: 'done' }));
        this.modal.querySelector('#nt-batch-archive').addEventListener('click', () => this._batch({ archived: true, status: 'archived' }));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.opened) this.close();
        });
        window.addEventListener('synapse:voiceTranscriptReady', e => this._attachVoiceTranscript(e.detail));
        window.addEventListener('synapse:notesCapture', e => this.captureFromSource(e.detail || {}, { type: e.detail?.type || 'note' }));
    }

    async open() {
        this.opened = true;
        this.modal.classList.add('open');
        await this._load();
        refreshIcons();
    }

    close() {
        this.opened = false;
        this.modal.classList.remove('open');
    }

    async _load() {
        try {
            this.items = await notesTaskService.list(this.filters);
        } catch (err) {
            console.error('[NotesTasksPanel] Load failed:', err);
            toast.error('Could not load notes/tasks');
            this.items = [];
        }
        this._renderLanes();
        await this._renderEditor();
        refreshIcons();
    }

    async _capture(event) {
        event.preventDefault();
        const titleInput = this.modal.querySelector('#nt-new-title');
        const title = titleInput.value.trim();
        if (!title) return;
        const type = this.modal.querySelector('#nt-new-type').value;
        const item = await notesTaskService.save({ type, title, status: type === 'note' ? 'active' : 'inbox' });
        titleInput.value = '';
        this.activeId = item.id;
        toast.success(`${type === 'task' ? 'Task' : 'Note'} captured`);
        await this._load();
    }

    _renderLanes() {
        const lanes = this.modal.querySelector('#nt-lanes');
        const active = this.items.filter(item => !item.archived && item.status !== 'done');
        const overdue = active.filter(item => item.dueAt && new Date(`${item.dueAt}T23:59:59`) < new Date());
        const upcoming = active.filter(item => item.dueAt && !overdue.includes(item)).slice(0, 6);
        const pinned = this.items.filter(item => item.pinned || item.favorite);
        lanes.innerHTML = [
            this._lane('Pinned & favorites', pinned),
            this._lane('Overdue', overdue),
            this._lane('Upcoming', upcoming),
            this._lane('All work', this.items)
        ].join('');
        lanes.querySelectorAll('.nt-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.matches('input[type="checkbox"]')) return;
                this.activeId = card.dataset.id;
                this._renderLanes();
                this._renderEditor();
            });
        });
        lanes.querySelectorAll('.nt-select').forEach(box => {
            box.addEventListener('change', e => {
                if (e.target.checked) this.selected.add(e.target.dataset.id);
                else this.selected.delete(e.target.dataset.id);
                this._renderSelectedCount();
            });
        });
        this._renderSelectedCount();
    }

    _lane(title, items) {
        return `<section class="nt-lane"><h3>${escapeHtml(title)} <span>${items.length}</span></h3>${items.length ? items.map(item => this._card(item)).join('') : '<p class="nt-empty">Nothing here.</p>'}</section>`;
    }

    _card(item) {
        const checklistDone = (item.checklist || []).filter(check => check.done).length;
        const checklistTotal = (item.checklist || []).length;
        return `
            <article class="nt-card ${item.id === this.activeId ? 'active' : ''}" data-id="${item.id}">
                <input class="nt-select" data-id="${item.id}" type="checkbox" ${this.selected.has(item.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(item.title)}">
                <div>
                    <strong>${item.pinned ? '📌 ' : ''}${item.favorite ? '★ ' : ''}${escapeHtml(item.title)}</strong>
                    <small>${escapeHtml(item.type)} · ${escapeHtml(item.status)} · ${escapeHtml(item.priority)}${item.dueAt ? ` · due ${escapeHtml(formatDate(item.dueAt))}` : ''}</small>
                    <small>${escapeHtml(item.projectId || 'default')} / ${escapeHtml(item.listId || 'inbox')}${checklistTotal ? ` · ${checklistDone}/${checklistTotal} checks` : ''}</small>
                </div>
            </article>`;
    }

    async _renderEditor() {
        const editor = this.modal.querySelector('#nt-editor');
        const item = this.activeId ? await notesTaskService.get(this.activeId) : null;
        if (!item) {
            editor.className = 'nt-editor-empty';
            editor.textContent = 'Select or capture an item to start.';
            return;
        }
        editor.className = 'nt-editor';
        const statuses = item.type === 'note' ? NOTE_STATUSES : TASK_STATUSES;
        editor.innerHTML = `
            <div class="nt-editor-top">
                <input id="nt-title" value="${escapeHtml(item.title)}" placeholder="Title">
                <button id="nt-pin" type="button">${item.pinned ? 'Unpin' : 'Pin'}</button>
                <button id="nt-favorite" type="button">${item.favorite ? 'Unfavorite' : 'Favorite'}</button>
                <button id="nt-archive" type="button">Archive</button>
            </div>
            <div class="nt-meta-grid">
                <label>Type<select id="nt-type"><option value="task" ${item.type === 'task' ? 'selected' : ''}>task</option><option value="note" ${item.type === 'note' ? 'selected' : ''}>note</option></select></label>
                <label>Status<select id="nt-status">${optionList(statuses, item.status)}</select></label>
                <label>Priority<select id="nt-priority">${optionList(PRIORITIES, item.priority)}</select></label>
                <label>Due<input id="nt-due" type="date" value="${escapeHtml(dateInput(item.dueAt))}"></label>
                <label>Start<input id="nt-start" type="date" value="${escapeHtml(dateInput(item.startAt))}"></label>
                <label>Reminder<input id="nt-reminder" type="datetime-local" value="${escapeHtml(item.reminder?.at ? item.reminder.at.slice(0, 16) : '')}"></label>
                <label>Project<input id="nt-project" value="${escapeHtml(item.projectId || '')}"></label>
                <label>List<input id="nt-list" value="${escapeHtml(item.listId || '')}"></label>
                <label>Recurrence<input id="nt-recurrence" placeholder="none/daily/weekly" value="${escapeHtml(item.recurrence?.frequency || 'none')}"></label>
                <label>Tags<input id="nt-tags" value="${escapeHtml((item.tags || []).join(', '))}"></label>
                <label>Links<input id="nt-links" value="${escapeHtml((item.links || []).join(', '))}"></label>
                <label class="nt-agent"><input id="nt-agent-runnable" type="checkbox" ${item.agentRunnable ? 'checked' : ''}> Agent-runnable</label>
            </div>
            <textarea id="nt-body" placeholder="Body, context, notes...">${escapeHtml(item.body || '')}</textarea>
            <section class="nt-checklist">
                <h3>Checklist</h3>
                <div id="nt-checklist-items">${(item.checklist || []).map(check => `<label><input data-id="${check.id}" type="checkbox" ${check.done ? 'checked' : ''}> ${escapeHtml(check.text)}</label>`).join('') || '<p class="nt-empty">No checklist items yet.</p>'}</div>
                <form id="nt-add-check"><input id="nt-new-check" placeholder="Add checklist item..."><button type="submit">Add</button></form>
            </section>
            <section class="nt-actions">
                <button data-ai="task-list" type="button">AI: task list</button>
                <button data-ai="summary" type="button">AI: summarize state</button>
                <button data-ai="deadlines" type="button">AI: extract deadlines</button>
                <button data-ai="next-actions" type="button">AI: next actions</button>
                <button id="nt-schedule" type="button">Schedule on calendar</button>
            </section>
            <section id="nt-suggestion" class="nt-suggestion hidden"></section>
            <section class="nt-sources">
                <h3>Sources</h3>
                ${(item.sourceRefs || []).map(ref => `<p><strong>${escapeHtml(ref.type)}</strong>: ${escapeHtml(ref.title)} ${ref.url ? `<a href="${escapeHtml(ref.url)}" target="_blank" rel="noreferrer">open</a>` : ''}</p>`).join('') || '<p class="nt-empty">Manual item with no source refs.</p>'}
            </section>
        `;
        this._bindEditorEvents(item);
    }

    _bindEditorEvents(item) {
        const save = patch => this._scheduleSave(item.id, patch);
        ['title', 'body', 'type', 'status', 'priority', 'project', 'list', 'tags', 'links', 'due', 'start', 'reminder', 'recurrence'].forEach(name => {
            const el = this.modal.querySelector(`#nt-${name}`);
            el?.addEventListener('input', () => save(this._editorPatch()));
            el?.addEventListener('change', () => save(this._editorPatch()));
        });
        this.modal.querySelector('#nt-agent-runnable')?.addEventListener('change', e => save({ agentRunnable: e.target.checked }));
        this.modal.querySelector('#nt-pin')?.addEventListener('click', () => this._toggle(item.id, { pinned: !item.pinned }));
        this.modal.querySelector('#nt-favorite')?.addEventListener('click', () => this._toggle(item.id, { favorite: !item.favorite }));
        this.modal.querySelector('#nt-archive')?.addEventListener('click', () => this._toggle(item.id, { archived: true, status: 'archived' }));
        this.modal.querySelectorAll('#nt-checklist-items input').forEach(box => box.addEventListener('change', async e => { await notesTaskService.toggleChecklist(item.id, e.target.dataset.id); await this._load(); }));
        this.modal.querySelector('#nt-add-check')?.addEventListener('submit', e => this._addChecklist(e, item));
        this.modal.querySelectorAll('[data-ai]').forEach(btn => btn.addEventListener('click', e => this._showSuggestion(item.id, e.target.dataset.ai)));
        this.modal.querySelector('#nt-schedule')?.addEventListener('click', () => this._scheduleItem(item));
    }

    _editorPatch() {
        return {
            title: this.modal.querySelector('#nt-title')?.value,
            body: this.modal.querySelector('#nt-body')?.value,
            type: this.modal.querySelector('#nt-type')?.value,
            status: this.modal.querySelector('#nt-status')?.value,
            priority: this.modal.querySelector('#nt-priority')?.value,
            dueAt: this.modal.querySelector('#nt-due')?.value || null,
            startAt: this.modal.querySelector('#nt-start')?.value || null,
            reminder: { at: this.modal.querySelector('#nt-reminder')?.value || null, channels: ['in-app'] },
            recurrence: { frequency: this.modal.querySelector('#nt-recurrence')?.value || 'none' },
            projectId: this.modal.querySelector('#nt-project')?.value || 'default',
            listId: this.modal.querySelector('#nt-list')?.value || 'inbox',
            tags: this.modal.querySelector('#nt-tags')?.value,
            links: this.modal.querySelector('#nt-links')?.value
        };
    }

    _scheduleSave(itemId, patch) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(async () => {
            try {
                await notesTaskService.update(itemId, patch);
                await this._load();
            } catch (err) {
                console.error('[NotesTasksPanel] Save failed:', err);
                toast.error('Could not save item');
            }
        }, 350);
    }

    async _toggle(itemId, patch) {
        await notesTaskService.update(itemId, patch);
        await this._load();
    }

    async _addChecklist(event, item) {
        event.preventDefault();
        const input = this.modal.querySelector('#nt-new-check');
        const text = input.value.trim();
        if (!text) return;
        await notesTaskService.update(item.id, { checklist: [...(item.checklist || []), { text }] });
        input.value = '';
        await this._load();
    }

    async _showSuggestion(itemId, kind) {
        const suggestion = await notesTaskService.makeAiSuggestion(itemId, kind);
        const box = this.modal.querySelector('#nt-suggestion');
        box.classList.remove('hidden');
        box.innerHTML = `<strong>${escapeHtml(suggestion.title)}</strong><pre>${escapeHtml(suggestion.content)}</pre>`;
    }

    _scheduleItem(item) {
        window.dispatchEvent(new CustomEvent('synapse:calendarCreateDraft', {
            detail: {
                id: item.id,
                type: item.type,
                title: item.title,
                body: item.body,
                dueAt: item.dueAt || item.startAt || item.reminder?.at,
                sourceRefs: item.sourceRefs,
                links: item.links
            }
        }));
        toast.success('Calendar draft opened');
    }

    async _batch(patch) {
        if (!this.selected.size) return;
        await notesTaskService.batchUpdate([...this.selected], patch);
        this.selected.clear();
        toast.success('Batch update applied');
        await this._load();
    }

    _renderSelectedCount() {
        const count = this.modal.querySelector('#nt-selected-count');
        if (count) count.textContent = `${this.selected.size} selected`;
    }

    async captureFromSource(source, overrides = {}) {
        const item = await notesTaskService.convertFromSource(source, overrides);
        this.activeId = item.id;
        if (this.opened) await this._load();
        return item;
    }

    async _attachVoiceTranscript(detail = {}) {
        if (!this.opened || !this.activeId || !detail?.transcript) return;
        const item = await notesTaskService.get(this.activeId);
        if (!item) return;
        const timestamp = new Date().toLocaleString();
        const transcriptBlock = `\n\n### Voice Transcript (${timestamp})\n${detail.transcript.trim()}`;
        await notesTaskService.update(item.id, { body: `${item.body || ''}${transcriptBlock}` });
        toast.success('Voice transcript attached to active note/task');
        await this._load();
    }
}

export function createNotesTasksPanel() {
    return new NotesTasksPanel();
}

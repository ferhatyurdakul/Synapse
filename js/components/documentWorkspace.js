import { documentService, DOCUMENT_TYPES, STATUSES } from '../services/documentService.js';
import { escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

function formatDate(value) {
    return value ? new Date(value).toLocaleString() : 'never';
}

function optionList(values, selected) {
    return values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}

class DocumentWorkspace {
    constructor() {
        this.isOpen = false;
        this.documents = [];
        this.openTabs = [];
        this.activeId = null;
        this.filters = { query: '', type: '', status: '', includeArchived: false };
        this.suggestion = null;
        this._saveTimer = null;
        this._renderShell();
    }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'document-workspace-modal';
        modal.className = 'doc-modal';
        modal.innerHTML = `
            <div class="doc-overlay"></div>
            <div class="doc-panel">
                <header class="doc-header">
                    <div>
                        <h2><i data-lucide="file-text" class="icon"></i> Document Workspace</h2>
                        <p>First-class documents with metadata, autosave, AI suggestions, versions, import/export, and RAG shadows.</p>
                    </div>
                    <button class="doc-close" id="doc-close-btn" type="button">&times;</button>
                </header>
                <div class="doc-body">
                    <aside class="doc-library">
                        <div class="doc-toolbar">
                            <input id="doc-search" type="search" placeholder="Search documents..." autocomplete="off">
                            <select id="doc-type-filter"><option value="">All types</option>${optionList(DOCUMENT_TYPES, '')}</select>
                            <select id="doc-status-filter"><option value="">All states</option>${optionList(STATUSES, '')}</select>
                            <label class="doc-check"><input id="doc-archived-filter" type="checkbox"> Archived</label>
                        </div>
                        <div class="doc-create-row">
                            <select id="doc-template-select">${documentService.listTemplates().map(t => `<option value="${t.type}">${t.type}</option>`).join('')}</select>
                            <button id="doc-new-btn" class="doc-primary" type="button"><i data-lucide="plus" class="icon"></i> New</button>
                            <button id="doc-import-btn" type="button"><i data-lucide="upload" class="icon"></i> Import</button>
                            <input id="doc-import-input" type="file" multiple class="hidden" accept=".md,.markdown,.txt,.html,.htm,.csv,.js,.ts,.py,.css,.json,.yaml,.yml,.toml,.sh,.sql,text/*">
                        </div>
                        <div id="doc-list" class="doc-list"></div>
                    </aside>
                    <section class="doc-editor-shell">
                        <div id="doc-tabs" class="doc-tabs"></div>
                        <div id="doc-editor" class="doc-editor-empty"></div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindShellEvents();
    }

    _bindShellEvents() {
        this.modal.querySelector('#doc-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.doc-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#doc-search').addEventListener('input', e => {
            this.filters.query = e.target.value;
            this._load();
        });
        this.modal.querySelector('#doc-type-filter').addEventListener('change', e => {
            this.filters.type = e.target.value;
            this._load();
        });
        this.modal.querySelector('#doc-status-filter').addEventListener('change', e => {
            this.filters.status = e.target.value;
            this._load();
        });
        this.modal.querySelector('#doc-archived-filter').addEventListener('change', e => {
            this.filters.includeArchived = e.target.checked;
            this._load();
        });
        this.modal.querySelector('#doc-new-btn').addEventListener('click', () => this._create());
        this.modal.querySelector('#doc-import-btn').addEventListener('click', () => this.modal.querySelector('#doc-import-input').click());
        this.modal.querySelector('#doc-import-input').addEventListener('change', e => this._import(e.target.files));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
        window.addEventListener('synapse:voiceTranscriptReady', e => this._attachVoiceTranscript(e.detail));
    }

    async open() {
        this.isOpen = true;
        this.modal.classList.add('open');
        await this._load();
        this._renderEditor();
        refreshIcons();
    }

    close() {
        this.isOpen = false;
        this.modal.classList.remove('open');
    }

    async _load() {
        try {
            this.documents = await documentService.list(this.filters);
        } catch (err) {
            console.error('[DocumentWorkspace] Load failed:', err);
            toast.error('Could not load documents');
            this.documents = [];
        }
        this._renderList();
        this._renderTabs();
    }

    _renderList() {
        const list = this.modal.querySelector('#doc-list');
        if (!this.documents.length) {
            list.innerHTML = '<div class="doc-empty">No documents yet. Create one from a template or import files.</div>';
            return;
        }
        list.innerHTML = this.documents.map(doc => `
            <article class="doc-card ${doc.id === this.activeId ? 'active' : ''}" data-open="${doc.id}">
                <div class="doc-card-main">
                    <strong>${escapeHtml(doc.title)}</strong>
                    <span>${escapeHtml(doc.type)} · ${escapeHtml(doc.status)} · rev ${doc.revision || 1}</span>
                    <small>${escapeHtml((doc.tags || []).join(', ') || 'no tags')} · ${formatDate(doc.updatedAt)}</small>
                </div>
                <div class="doc-card-actions">
                    <button data-dup="${doc.id}" title="Duplicate"><i data-lucide="copy" class="icon"></i></button>
                    <button data-archive="${doc.id}" title="Archive/unarchive"><i data-lucide="archive" class="icon"></i></button>
                    <button data-delete="${doc.id}" title="Delete"><i data-lucide="trash-2" class="icon"></i></button>
                </div>
            </article>
        `).join('');
        list.querySelectorAll('[data-open]').forEach(card => card.addEventListener('click', e => {
            if (e.target.closest('button')) return;
            this._openTab(card.dataset.open);
        }));
        list.querySelectorAll('[data-dup]').forEach(btn => btn.addEventListener('click', e => this._duplicate(e.currentTarget.dataset.dup)));
        list.querySelectorAll('[data-archive]').forEach(btn => btn.addEventListener('click', e => this._archive(e.currentTarget.dataset.archive)));
        list.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', e => this._delete(e.currentTarget.dataset.delete)));
        refreshIcons();
    }

    async _create() {
        const type = this.modal.querySelector('#doc-template-select').value;
        const doc = await documentService.create({ type });
        await this._load();
        this._openTab(doc.id);
        toast.success('Document created');
    }

    async _import(files) {
        if (!files?.length) return;
        const docs = await documentService.importFiles(files);
        this.modal.querySelector('#doc-import-input').value = '';
        await this._load();
        if (docs[0]) this._openTab(docs[0].id);
        toast.success(`Imported ${docs.length} document(s)`);
    }

    async _openTab(id) {
        const doc = await documentService.get(id);
        if (!doc) return;
        this.openTabs = [doc, ...this.openTabs.filter(tab => tab.id !== id)].slice(0, 6);
        this.activeId = id;
        this.suggestion = null;
        this._renderTabs();
        this._renderList();
        this._renderEditor();
    }

    _renderTabs() {
        const tabs = this.modal.querySelector('#doc-tabs');
        if (!this.openTabs.length) {
            tabs.innerHTML = '';
            return;
        }
        tabs.innerHTML = this.openTabs.map(tab => `
            <button class="doc-tab ${tab.id === this.activeId ? 'active' : ''}" data-tab="${tab.id}">
                ${escapeHtml(tab.title)} <span data-close-tab="${tab.id}">&times;</span>
            </button>
        `).join('');
        tabs.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', e => {
            if (e.target.dataset.closeTab) return;
            this.activeId = btn.dataset.tab;
            this.suggestion = null;
            this._renderTabs();
            this._renderList();
            this._renderEditor();
        }));
        tabs.querySelectorAll('[data-close-tab]').forEach(btn => btn.addEventListener('click', e => {
            e.stopPropagation();
            this.openTabs = this.openTabs.filter(tab => tab.id !== btn.dataset.closeTab);
            if (this.activeId === btn.dataset.closeTab) this.activeId = this.openTabs[0]?.id || null;
            this._renderTabs();
            this._renderEditor();
        }));
    }

    _activeDoc() {
        return this.openTabs.find(tab => tab.id === this.activeId) || null;
    }

    _renderEditor() {
        const editor = this.modal.querySelector('#doc-editor');
        const doc = this._activeDoc();
        if (!doc) {
            editor.className = 'doc-editor-empty';
            editor.innerHTML = '<div><h3>No document open</h3><p>Select a document from the library or create a new one.</p></div>';
            return;
        }
        editor.className = 'doc-editor';
        editor.innerHTML = `
            <div class="doc-meta-grid">
                <label>Title<input id="doc-title" value="${escapeHtml(doc.title)}"></label>
                <label>Type<select id="doc-type">${optionList(DOCUMENT_TYPES, doc.type)}</select></label>
                <label>Status<select id="doc-status">${optionList(STATUSES.filter(s => s !== 'archived'), doc.status === 'archived' ? 'draft' : doc.status)}</select></label>
                <label>Tags<input id="doc-tags" value="${escapeHtml((doc.tags || []).join(', '))}" placeholder="planning, research"></label>
                <label>Origin<input id="doc-origin" value="${escapeHtml(doc.origin || '')}"></label>
                <label>Project / workspace<input id="doc-project" value="${escapeHtml(doc.projectId || 'default')}"></label>
            </div>
            <div class="doc-actions">
                <button data-action="snapshot"><i data-lucide="history" class="icon"></i> Snapshot</button>
                <button data-action="export"><i data-lucide="download" class="icon"></i> Export</button>
                <button data-action="summarize">Summarize</button>
                <button data-action="outline">Outline</button>
                <button data-action="rewrite">Rewrite</button>
                <button data-action="suggest">Suggest Edits</button>
                <button data-action="compare">Compare</button>
                <span id="doc-save-state">Autosaved ${formatDate(doc.updatedAt)}</span>
            </div>
            <textarea id="doc-content" spellcheck="true">${escapeHtml(doc.content || '')}</textarea>
            <div id="doc-suggestion" class="doc-suggestion ${this.suggestion ? '' : 'hidden'}"></div>
            <details class="doc-versions" id="doc-versions"><summary>Version history</summary><div id="doc-version-list">Loading...</div></details>
        `;
        ['doc-title', 'doc-type', 'doc-status', 'doc-tags', 'doc-origin', 'doc-project', 'doc-content'].forEach(id => {
            editor.querySelector(`#${id}`).addEventListener('input', () => this._scheduleSave());
            editor.querySelector(`#${id}`).addEventListener('change', () => this._scheduleSave(10));
        });
        editor.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', e => this._runAction(e.currentTarget.dataset.action)));
        this._renderSuggestion();
        this._renderVersions();
        refreshIcons();
    }

    _collectPatch() {
        return {
            title: this.modal.querySelector('#doc-title').value,
            type: this.modal.querySelector('#doc-type').value,
            status: this.modal.querySelector('#doc-status').value,
            tags: this.modal.querySelector('#doc-tags').value,
            origin: this.modal.querySelector('#doc-origin').value,
            projectId: this.modal.querySelector('#doc-project').value,
            content: this.modal.querySelector('#doc-content').value
        };
    }

    _scheduleSave(delay = 600) {
        clearTimeout(this._saveTimer);
        this.modal.querySelector('#doc-save-state').textContent = 'Saving...';
        this._saveTimer = setTimeout(() => this._save(), delay);
    }

    async _save() {
        const doc = this._activeDoc();
        if (!doc) return;
        const saved = await documentService.update(doc.id, this._collectPatch(), { snapshot: false });
        this.openTabs = this.openTabs.map(tab => tab.id === saved.id ? saved : tab);
        this.modal.querySelector('#doc-save-state').textContent = `Autosaved ${formatDate(saved.updatedAt)}`;
        await this._load();
    }

    async _runAction(action) {
        const doc = this._activeDoc();
        if (!doc) return;
        if (action === 'snapshot') {
            await documentService.snapshot(doc.id, 'manual snapshot');
            await this._renderVersions();
            toast.success('Snapshot saved');
            return;
        }
        if (action === 'export') {
            const { blob, filename } = documentService.exportDocument(doc);
            this._download(blob, filename);
            return;
        }
        this.suggestion = await documentService.makeSuggestion(doc.id, action);
        this._renderSuggestion();
    }

    _renderSuggestion() {
        const node = this.modal.querySelector('#doc-suggestion');
        if (!node) return;
        if (!this.suggestion) {
            node.classList.add('hidden');
            node.innerHTML = '';
            return;
        }
        node.classList.remove('hidden');
        node.innerHTML = `
            <div><strong>${escapeHtml(this.suggestion.kind)}</strong><span>${escapeHtml(this.suggestion.rationale)}</span></div>
            <pre>${escapeHtml(this.suggestion.content)}</pre>
            <button id="doc-accept-suggestion" class="doc-primary">Accept</button>
            <button id="doc-reject-suggestion">Reject</button>
        `;
        node.querySelector('#doc-accept-suggestion').addEventListener('click', async () => {
            const saved = await documentService.acceptSuggestion(this.activeId, this.suggestion);
            this.openTabs = this.openTabs.map(tab => tab.id === saved.id ? saved : tab);
            this.suggestion = null;
            await this._load();
            this._renderEditor();
            toast.success('Suggestion accepted');
        });
        node.querySelector('#doc-reject-suggestion').addEventListener('click', () => {
            this.suggestion = null;
            this._renderSuggestion();
        });
    }

    async _renderVersions() {
        const doc = this._activeDoc();
        const list = this.modal.querySelector('#doc-version-list');
        if (!doc || !list) return;
        const versions = await documentService.versions(doc.id);
        if (!versions.length) {
            list.innerHTML = '<p>No snapshots yet.</p>';
            return;
        }
        list.innerHTML = versions.map(v => `
            <div class="doc-version-row">
                <span>rev ${v.revision} · ${escapeHtml(v.reason)} · ${formatDate(v.createdAt)}</span>
                <button data-restore-version="${v.id}">Restore</button>
            </div>
        `).join('');
        list.querySelectorAll('[data-restore-version]').forEach(btn => btn.addEventListener('click', async () => {
            const saved = await documentService.restoreVersion(doc.id, btn.dataset.restoreVersion);
            this.openTabs = this.openTabs.map(tab => tab.id === saved.id ? saved : tab);
            await this._load();
            this._renderEditor();
            toast.success('Version restored');
        }));
    }

    async _duplicate(id) {
        const doc = await documentService.duplicate(id);
        await this._load();
        this._openTab(doc.id);
    }

    async _archive(id) {
        const doc = await documentService.get(id);
        await documentService.archive(id, !doc.archived);
        await this._load();
    }

    async _delete(id) {
        if (!confirm('Delete this document and all snapshots?')) return;
        await documentService.delete(id);
        this.openTabs = this.openTabs.filter(tab => tab.id !== id);
        if (this.activeId === id) this.activeId = this.openTabs[0]?.id || null;
        await this._load();
        this._renderEditor();
    }

    _download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    async _attachVoiceTranscript(detail = {}) {
        const doc = this._activeDoc();
        if (!this.isOpen || !doc || !detail?.transcript) return;
        const timestamp = new Date().toLocaleString();
        const transcriptBlock = `\n\n## Voice Transcript (${timestamp})\n${detail.transcript.trim()}`;
        const saved = await documentService.update(doc.id, {
            content: `${doc.content || ''}${transcriptBlock}`,
            origin: doc.origin || 'voice transcript'
        }, { snapshot: true, reason: 'voice transcript attached' });
        this.openTabs = this.openTabs.map(tab => tab.id === saved.id ? saved : tab);
        await this._load();
        this._renderEditor();
        toast.success('Voice transcript attached to active document');
    }
}

export function createDocumentWorkspace() {
    return new DocumentWorkspace();
}

/**
 * MemoryPanel — Modal UI for browsing, searching, editing, and managing
 * semantic memory entries. Also provides import/export/compact actions.
 *
 * Uses its own CSS (css/memory.css) — does not touch styles.css or modern.css.
 */

import { memoryService } from '../services/memoryService.js';
import { toast } from './toast.js';
import { escapeHtml } from '../utils/markdown.js';

const LAYER_COLORS = {
    fact: 'layer-fact',
    preference: 'layer-preference',
    procedure: 'layer-procedure',
    context: 'layer-context'
};

function formatRelativeTime(isoStr) {
    if (!isoStr) return 'unknown';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(isoStr).toLocaleDateString();
}

class MemoryPanel {
    constructor() {
        this.isOpen = false;
        this.entries = [];
        this.activeFilter = null;   // layer filter or null for all
        this.searchQuery = '';
        this.showAddForm = false;
        this.editingId = null;
        this._searchDebounce = null;
        this._render();
    }

    _render() {
        const modal = document.createElement('div');
        modal.id = 'memory-modal';
        modal.className = 'memory-modal';
        modal.innerHTML = `
            <div class="mem-overlay"></div>
            <div class="mem-panel">
                <div class="mem-header">
                    <h2><i data-lucide="brain" class="icon"></i> Semantic Memory</h2>
                    <div class="mem-header-actions">
                        <button class="mem-action-btn" id="mem-compact-btn" title="Merge duplicate memories">
                            <i data-lucide="layers" class="icon"></i> Compact
                        </button>
                        <button class="mem-action-btn" id="mem-export-btn" title="Export memories as JSON">
                            <i data-lucide="download" class="icon"></i> Export
                        </button>
                        <button class="mem-action-btn" id="mem-import-btn" title="Import memories from JSON">
                            <i data-lucide="upload" class="icon"></i> Import
                        </button>
                        <button class="mem-close-btn" id="mem-close-btn" title="Close">&times;</button>
                    </div>
                </div>
                <div class="mem-toolbar">
                    <input type="text" class="mem-search-input" id="mem-search" placeholder="Search memories..." autocomplete="off">
                    <button class="mem-filter-btn active" data-filter="">All</button>
                    <button class="mem-filter-btn" data-filter="fact">Facts</button>
                    <button class="mem-filter-btn" data-filter="preference">Prefs</button>
                    <button class="mem-filter-btn" data-filter="procedure">Procs</button>
                    <button class="mem-filter-btn" data-filter="context">Context</button>
                    <button class="mem-action-btn primary" id="mem-add-btn">
                        <i data-lucide="plus" class="icon"></i> Add
                    </button>
                </div>
                <div class="mem-stats-bar" id="mem-stats-bar"></div>
                <div class="mem-content" id="mem-content"></div>
                <div class="mem-footer">
                    <span id="mem-footer-stats">Loading...</span>
                    <span>Memories are injected into chat context automatically</span>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this._attachEvents();
    }

    _attachEvents() {
        // Close
        this.modal.querySelector('#mem-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.mem-overlay').addEventListener('click', () => this.close());

        // Search
        const searchInput = this.modal.querySelector('#mem-search');
        searchInput.addEventListener('input', () => {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(() => {
                this.searchQuery = searchInput.value.trim();
                this._loadEntries();
            }, 250);
        });

        // Filter buttons
        this.modal.querySelectorAll('.mem-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.modal.querySelectorAll('.mem-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.activeFilter = btn.dataset.filter || null;
                this._loadEntries();
            });
        });

        // Add
        this.modal.querySelector('#mem-add-btn').addEventListener('click', () => {
            this.showAddForm = !this.showAddForm;
            this._renderContent();
        });

        // Export
        this.modal.querySelector('#mem-export-btn').addEventListener('click', () => this._export());
        // Import
        this.modal.querySelector('#mem-import-btn').addEventListener('click', () => this._import());
        // Compact
        this.modal.querySelector('#mem-compact-btn').addEventListener('click', () => this._compact());

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });
    }

    async open() {
        this.isOpen = true;
        this.modal.classList.add('open');
        await this._loadEntries();
        await this._updateStats();
        if (typeof lucide !== 'undefined') refreshIcons();
    }

    close() {
        this.isOpen = false;
        this.modal.classList.remove('open');
    }

    async _loadEntries() {
        try {
            if (this.searchQuery) {
                const results = await memoryService.search(this.searchQuery, {
                    layer: this.activeFilter || undefined
                });
                this.entries = results.map(r => ({ ...r.entry, _score: r.score }));
            } else {
                const list = await memoryService.list({
                    layer: this.activeFilter || undefined
                });
                this.entries = list;
            }
        } catch (err) {
            console.error('[MemoryPanel] Load failed:', err);
            this.entries = [];
        }
        this._renderContent();
    }

    async _updateStats() {
        try {
            const stats = await memoryService.getStats();
            this.modal.querySelector('#mem-stats-bar').innerHTML = `
                <span class="mem-stat"><strong>${stats.total}</strong> entries</span>
                <span class="mem-stat">Facts: ${stats.byLayer.fact || 0}</span>
                <span class="mem-stat">Prefs: ${stats.byLayer.preference || 0}</span>
                <span class="mem-stat">Procs: ${stats.byLayer.procedure || 0}</span>
                <span class="mem-stat">Ctx: ${stats.byLayer.context || 0}</span>
                <span class="mem-stat">${stats.embedded.ready} embedded / ${stats.embedded.pending} pending</span>
            `;
            this.modal.querySelector('#mem-footer-stats').textContent =
                `${stats.total} memories across ${stats.projectCount} project(s)`;
        } catch (err) {
            console.warn('[MemoryPanel] Stats failed:', err);
        }
    }

    _renderContent() {
        const container = this.modal.querySelector('#mem-content');

        let html = '';

        // Add form
        if (this.showAddForm) {
            html += this._buildAddForm();
        }

        // Entries
        if (this.entries.length === 0 && !this.showAddForm) {
            html += `
                <div class="mem-empty">
                    <div class="mem-empty-icon">🧠</div>
                    <div><strong>No memories yet</strong></div>
                    <p>Add facts, preferences, or procedures to build your semantic memory.</p>
                </div>
            `;
        } else {
            for (const entry of this.entries) {
                html += this._buildEntry(entry);
            }
        }

        container.innerHTML = html;
        this._attachContentEvents();
        if (typeof lucide !== 'undefined') refreshIcons();
    }

    _buildAddForm() {
        return `
            <div class="mem-add-form">
                <h4>Add New Memory</h4>
                <textarea class="mem-edit-textarea" id="mem-add-content" placeholder="Enter a fact, preference, procedure, or context..."></textarea>
                <div class="mem-edit-row">
                    <select id="mem-add-layer">
                        <option value="fact">Fact</option>
                        <option value="preference">Preference</option>
                        <option value="procedure">Procedure</option>
                        <option value="context">Context</option>
                    </select>
                    <label style="font-size:0.8rem;color:var(--text-secondary,#999);">
                        Confidence:
                        <input type="number" id="mem-add-confidence" min="0" max="1" step="0.1" value="0.8" style="width:52px;">
                    </label>
                    <button class="mem-action-btn primary" id="mem-add-save">Save</button>
                    <button class="mem-action-btn" id="mem-add-cancel">Cancel</button>
                </div>
            </div>
        `;
    }

    _buildEntry(entry) {
        const isEditing = this.editingId === entry.id;
        if (isEditing) return this._buildEditForm(entry);

        const layerClass = LAYER_COLORS[entry.layer] || '';
        const conf = ((entry.confidence || 0) * 100).toFixed(0);
        const sourceLabel = entry.source?.label || entry.source?.type || 'user';
        const scoreHtml = entry._score != null
            ? `<span class="mem-badge score">${(entry._score * 100).toFixed(0)}% match</span>`
            : '';
        const tagsHtml = (entry.tags?.length)
            ? `<div class="mem-entry-tags">${entry.tags.map(t => `<span class="mem-tag">${escapeHtml(t)}</span>`).join('')}</div>`
            : '';
        const projLabel = entry.projectId && entry.projectId !== '__global__'
            ? `<span>Project: ${escapeHtml(entry.projectId)}</span>` : '';

        return `
            <div class="mem-entry" data-id="${escapeHtml(entry.id)}">
                <div class="mem-entry-header">
                    <div class="mem-entry-badges">
                        <span class="mem-badge ${layerClass}">${escapeHtml(entry.layer)}</span>
                        <span class="mem-badge confidence">${conf}%</span>
                        <span class="mem-badge source">${escapeHtml(sourceLabel)}</span>
                        ${scoreHtml}
                    </div>
                    <div class="mem-entry-actions">
                        <button class="mem-icon-btn edit" data-action="edit" data-id="${escapeHtml(entry.id)}" title="Edit">✏️</button>
                        <button class="mem-icon-btn delete" data-action="delete" data-id="${escapeHtml(entry.id)}" title="Delete">🗑️</button>
                    </div>
                </div>
                <div class="mem-entry-content">${escapeHtml(entry.content)}</div>
                ${tagsHtml}
                <div class="mem-entry-meta">
                    <span>Created ${formatRelativeTime(entry.createdAt)}</span>
                    <span>Updated ${formatRelativeTime(entry.updatedAt)}</span>
                    <span>Accessed ${entry.accessCount || 0}×</span>
                    ${projLabel}
                </div>
            </div>
        `;
    }

    _buildEditForm(entry) {
        return `
            <div class="mem-entry" data-id="${escapeHtml(entry.id)}">
                <div class="mem-edit-form">
                    <textarea class="mem-edit-textarea" id="mem-edit-content-${entry.id}">${escapeHtml(entry.content)}</textarea>
                    <div class="mem-edit-row">
                        <select id="mem-edit-layer-${entry.id}">
                            <option value="fact" ${entry.layer === 'fact' ? 'selected' : ''}>Fact</option>
                            <option value="preference" ${entry.layer === 'preference' ? 'selected' : ''}>Preference</option>
                            <option value="procedure" ${entry.layer === 'procedure' ? 'selected' : ''}>Procedure</option>
                            <option value="context" ${entry.layer === 'context' ? 'selected' : ''}>Context</option>
                        </select>
                        <label style="font-size:0.8rem;color:var(--text-secondary,#999);">
                            Conf:
                            <input type="number" id="mem-edit-conf-${entry.id}" min="0" max="1" step="0.1"
                                   value="${entry.confidence}" style="width:52px;">
                        </label>
                        <button class="mem-action-btn primary" data-action="save-edit" data-id="${escapeHtml(entry.id)}">Save</button>
                        <button class="mem-action-btn" data-action="cancel-edit">Cancel</button>
                    </div>
                </div>
            </div>
        `;
    }

    _attachContentEvents() {
        const container = this.modal.querySelector('#mem-content');

        // Delegate clicks
        container.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            const id = btn.dataset.id;

            switch (action) {
                case 'edit':
                    this.editingId = id;
                    this._renderContent();
                    break;

                case 'delete':
                    if (confirm('Delete this memory?')) {
                        await memoryService.remove(id);
                        toast.success('Memory deleted');
                        await this._loadEntries();
                        await this._updateStats();
                    }
                    break;

                case 'save-edit':
                    await this._saveEdit(id);
                    break;

                case 'cancel-edit':
                    this.editingId = null;
                    this._renderContent();
                    break;
            }
        });

        // Add form buttons
        const addSave = container.querySelector('#mem-add-save');
        const addCancel = container.querySelector('#mem-add-cancel');
        if (addSave) {
            addSave.addEventListener('click', () => this._saveNew());
        }
        if (addCancel) {
            addCancel.addEventListener('click', () => {
                this.showAddForm = false;
                this._renderContent();
            });
        }
    }

    async _saveNew() {
        const content = this.modal.querySelector('#mem-add-content')?.value?.trim();
        const layer = this.modal.querySelector('#mem-add-layer')?.value || 'fact';
        const confidence = parseFloat(this.modal.querySelector('#mem-add-confidence')?.value || '0.8');

        if (!content) {
            toast.warning('Please enter some content');
            return;
        }

        try {
            await memoryService.store({
                content,
                layer,
                confidence,
                source: { type: 'user', label: 'manual' },
                tags: []
            });
            this.showAddForm = false;
            toast.success('Memory stored');
            await this._loadEntries();
            await this._updateStats();
        } catch (err) {
            toast.error('Failed to store memory: ' + err.message);
        }
    }

    async _saveEdit(entryId) {
        const content = this.modal.querySelector(`#mem-edit-content-${entryId}`)?.value?.trim();
        const layer = this.modal.querySelector(`#mem-edit-layer-${entryId}`)?.value;
        const confidence = parseFloat(this.modal.querySelector(`#mem-edit-conf-${entryId}`)?.value || '0.8');

        if (!content) {
            toast.warning('Content cannot be empty');
            return;
        }

        try {
            await memoryService.update(entryId, { content, layer, confidence });
            this.editingId = null;
            toast.success('Memory updated');
            await this._loadEntries();
            await this._updateStats();
        } catch (err) {
            toast.error('Failed to update memory: ' + err.message);
        }
    }

    async _export() {
        try {
            const json = await memoryService.exportMemory();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `synapse-memory-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success('Memory exported');
        } catch (err) {
            toast.error('Export failed: ' + err.message);
        }
    }

    async _import() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const result = await memoryService.importMemory(text);
                toast.success(`Imported ${result.imported} memories (${result.skipped} skipped)`);
                await this._loadEntries();
                await this._updateStats();
            } catch (err) {
                toast.error('Import failed: ' + err.message);
            }
        });
        input.click();
    }

    async _compact() {
        try {
            const result = await memoryService.compact();
            if (result.merged > 0) {
                toast.success(`Compacted: ${result.merged} duplicates merged`);
            } else {
                toast.info('No duplicate memories found to compact');
            }
            await this._loadEntries();
            await this._updateStats();
        } catch (err) {
            toast.error('Compaction failed: ' + err.message);
        }
    }
}

// Singleton
let _instance = null;

export function createMemoryPanel() {
    if (!_instance) {
        _instance = new MemoryPanel();
    }
    return _instance;
}

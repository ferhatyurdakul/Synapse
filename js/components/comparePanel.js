/**
 * ComparePanel — UI for Multi-model Compare & Committee Mode.
 *
 * Surfaces the compareService as a modal workspace: a library of saved compare
 * sessions on the left, and an editor/results pane on the right where the user
 * writes one shared prompt, picks 2–3 provider/model slots, toggles blind mode,
 * runs the comparison, rates each response, and (in committee mode) synthesizes
 * a merged answer. Results stream in live; everything is persisted so a session
 * can be exported or reopened as a normal chat.
 */

import { compareService } from '../services/compareService.js';
import { providerManager } from '../services/providerManager.js';
import { chatService } from '../services/chatService.js';
import { renderMarkdown, escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

const SLOT_LETTERS = ['A', 'B', 'C', 'D'];

function slotLabel(index) {
    return SLOT_LETTERS[index] || `#${index + 1}`;
}

function formatDate(value) {
    return value ? new Date(value).toLocaleString() : 'unknown';
}

function modelDisplay(entry, blind) {
    if (blind && !entry.revealed) return 'Identity hidden';
    return `${entry.provider}/${entry.model || 'unset'}`;
}

function statsText(entry) {
    const s = entry.stats || {};
    const parts = [];
    if (s.evalCount != null) parts.push(`${s.evalCount} tok`);
    if (s.tokensPerSecond != null) parts.push(`${s.tokensPerSecond} tok/s`);
    return parts.join(' · ') || '—';
}

function starsHtml(entryId, rating) {
    let html = '<span class="cmp-rating" aria-label="Rate this response">';
    for (let n = 1; n <= 5; n++) {
        html += `<button type="button" class="cmp-star ${n <= rating ? 'on' : ''}" data-rate="${entryId}" data-value="${n}" title="${n}/5">★</button>`;
    }
    html += '</span>';
    return html;
}

function badgeHtml(status) {
    return `<span class="cmp-badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function providerOptions(selected) {
    return providerManager.getAllProviders()
        .map(p => `<option value="${escapeHtml(p.name)}" ${p.name === selected ? 'selected' : ''}>${escapeHtml(p.label)}</option>`)
        .join('');
}

function modelOptions(models, selected) {
    const opts = (models || []).map(m =>
        `<option value="${escapeHtml(m)}" ${m === selected ? 'selected' : ''}>${escapeHtml(m)}</option>`
    ).join('');
    if (selected && !(models || []).includes(selected)) {
        return `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (not installed)</option>${opts}`;
    }
    return opts || '<option value="">No models found</option>';
}

class ComparePanel {
    constructor() {
        this.opened = false;
        this.sessions = [];
        this.activeId = null;
        this.active = null;
        this.filters = { query: '' };
        this._modelCache = {};   // providerName -> { available, models }
        this._runToken = 0;      // guards stale streaming patches
        this._persistTimer = null;
        this._renderShell();
    }

    // ─── Shell ────────────────────────────────────────────────────────────

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'compare-modal';
        modal.className = 'cmp-modal';
        modal.innerHTML = `
            <div class="cmp-overlay"></div>
            <div class="cmp-panel">
                <header class="cmp-header">
                    <div>
                        <h2><i data-lucide="git-compare" class="icon"></i> Compare &amp; Committee</h2>
                        <p>Run one prompt across 2–3 models side by side, rate the responses, and synthesize a committee answer.</p>
                    </div>
                    <button class="cmp-close" id="cmp-close-btn" type="button" aria-label="Close">&times;</button>
                </header>
                <div class="cmp-body">
                    <aside class="cmp-library">
                        <div class="cmp-toolbar">
                            <input id="cmp-search" type="search" placeholder="Search sessions…" autocomplete="off">
                        </div>
                        <div class="cmp-create-row">
                            <button id="cmp-new-btn" class="cmp-btn cmp-btn-primary" type="button"><i data-lucide="plus" class="icon"></i> New Compare</button>
                        </div>
                        <div id="cmp-list" class="cmp-list"></div>
                    </aside>
                    <section id="cmp-detail" class="cmp-detail-empty">
                        <div><h3>No session selected</h3><p>Create a new compare to begin.</p></div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this.detail = modal.querySelector('#cmp-detail');
        this._bindShellEvents();
    }

    _bindShellEvents() {
        this.modal.querySelector('#cmp-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.cmp-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#cmp-search').addEventListener('input', (e) => {
            this.filters.query = e.target.value;
            this._renderList();
        });
        this.modal.querySelector('#cmp-new-btn').addEventListener('click', () => this._newSession());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.opened) this.close();
        });
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

    isOpen() {
        return this.opened;
    }

    // ─── Data loading ─────────────────────────────────────────────────────

    async _load() {
        try {
            this.sessions = await compareService.list(this.filters);
        } catch (err) {
            console.error('[ComparePanel] load failed:', err);
            toast.error('Could not load compare sessions');
            this.sessions = [];
        }
        this._renderList();
        if (this.activeId) {
            // Keep the active session fresh (e.g. after external changes).
            const fresh = await compareService.get(this.activeId);
            if (fresh) {
                this.active = fresh;
                this._renderDetail();
            }
        }
    }

    _renderList() {
        const list = this.modal.querySelector('#cmp-list');
        if (!this.sessions.length) {
            list.innerHTML = '<div class="cmp-empty">No compare sessions yet.<br>Click “New Compare” to start.</div>';
            return;
        }
        list.innerHTML = this.sessions.map(s => {
            const entryCount = (s.entries || []).length;
            const modelSummary = (s.entries || [])
                .map((e, i) => s.blind ? slotLabel(i) : (e.model || '?'))
                .join(' · ');
            return `
                <article class="cmp-card ${s.id === this.activeId ? 'active' : ''}" data-open="${escapeHtml(s.id)}">
                    <div class="cmp-card-main">
                        <strong>${escapeHtml(s.title || 'Untitled')}</strong>
                        <span>${escapeHtml(s.mode)} · ${escapeHtml(s.status)} · ${entryCount} models</span>
                        <small>${escapeHtml(modelSummary)} · ${formatDate(s.updatedAt)}</small>
                    </div>
                    <div class="cmp-card-actions">
                        <button class="cmp-icon-btn" data-delete="${escapeHtml(s.id)}" title="Delete" aria-label="Delete"><i data-lucide="trash-2" class="icon"></i></button>
                    </div>
                </article>
            `;
        }).join('');
        list.querySelectorAll('[data-open]').forEach(card => card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            this._selectSession(card.dataset.open);
        }));
        list.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._deleteSession(e.currentTarget.dataset.delete);
        }));
        refreshIcons();
    }

    async _newSession() {
        const s = await compareService.create({ prompt: '', mode: 'compare', blind: false });
        await this._selectSession(s.id);
        toast.success('New compare session created');
        // Focus the prompt area for fast input
        setTimeout(() => this.detail.querySelector('#cmp-prompt')?.focus(), 50);
    }

    async _deleteSession(id) {
        if (!confirm('Delete this compare session? This cannot be undone.')) return;
        await compareService.delete(id);
        if (this.activeId === id) {
            this.activeId = null;
            this.active = null;
        }
        await this._load();
        toast.success('Compare session deleted');
    }

    async _selectSession(id) {
        this.activeId = id;
        const session = await compareService.get(id);
        if (!session) {
            await this._load();
            return;
        }
        const providers = [...new Set(session.entries.map(e => e.provider).filter(Boolean))];
        await Promise.all(providers.map(p => this._ensureModels(p)));
        this.active = session;
        this._renderList();
        this._renderDetail();
        refreshIcons();
    }

    async _ensureModels(providerName) {
        if (!providerName) return { available: false, models: [] };
        if (this._modelCache[providerName]) return this._modelCache[providerName];
        try {
            const res = await compareService.getModels(providerName);
            this._modelCache[providerName] = res;
            return res;
        } catch {
            this._modelCache[providerName] = { available: false, models: [] };
            return this._modelCache[providerName];
        }
    }

    _modelsFor(providerName) {
        return (this._modelCache[providerName] && this._modelCache[providerName].models) || [];
    }

    // ─── Detail (editor + results) ────────────────────────────────────────

    _renderDetail() {
        const s = this.active;
        if (!s) {
            this.detail.className = 'cmp-detail-empty';
            this.detail.innerHTML = '<div><h3>No session selected</h3><p>Create a new compare to begin.</p></div>';
            return;
        }

        const limits = compareService.getEntryLimits();
        const canAdd = s.entries.length < limits.max;

        this.detail.className = 'cmp-detail';
        this.detail.innerHTML = `
            <div class="cmp-section">
                <div class="cmp-row" style="justify-content:space-between">
                    <h4 style="margin:0">${escapeHtml(s.title || 'Untitled')}</h4>
                    ${badgeHtml(s.status)}
                </div>
            </div>

            <div class="cmp-section">
                <h4>Shared Prompt</h4>
                <div class="cmp-field">
                    <textarea id="cmp-prompt" class="cmp-textarea" placeholder="Type one prompt to send to every model…">${escapeHtml(s.prompt || '')}</textarea>
                </div>
                <details class="cmp-field" ${s.systemPrompt ? 'open' : ''}>
                    <summary style="cursor:pointer;color:var(--text-secondary,#9aa4b2);font-size:.8rem">System prompt (optional, shared)</summary>
                    <textarea id="cmp-system" class="cmp-textarea" style="margin-top:.4rem" placeholder="Optional shared system prompt…">${escapeHtml(s.systemPrompt || '')}</textarea>
                </details>
                <div class="cmp-row" style="margin-top:.6rem">
                    <div class="cmp-segmented" role="group" aria-label="Mode">
                        <button type="button" id="cmp-mode-compare" class="${s.mode === 'compare' ? 'active' : ''}">Compare</button>
                        <button type="button" id="cmp-mode-committee" class="${s.mode === 'committee' ? 'active' : ''}">Committee</button>
                    </div>
                    <label class="cmp-switch"><input type="checkbox" id="cmp-blind" ${s.blind ? 'checked' : ''}> Blind (hide model names)</label>
                    <label class="cmp-switch">Temp <input id="cmp-temp" type="number" step="0.1" min="0" max="2" value="${s.temperature}" style="width:4rem"></label>
                    <label class="cmp-switch">Ctx <input id="cmp-maxctx" type="number" step="512" min="512" value="${s.maxCtx}" style="width:5.5rem"></label>
                </div>
            </div>

            <div class="cmp-section">
                <h4>Models <span style="text-transform:none;font-weight:normal">(${s.entries.length}/${limits.max})</span></h4>
                <div id="cmp-entries" class="cmp-entries">
                    ${s.entries.map((e, i) => this._entryConfigHtml(e, i)).join('')}
                </div>
                ${canAdd ? `<button id="cmp-add-entry" class="cmp-btn cmp-add-entry" type="button"><i data-lucide="plus" class="icon"></i> Add model slot</button>` : ''}
            </div>

            <div class="cmp-actions">
                <button id="cmp-run" class="cmp-btn cmp-btn-primary" type="button"><i data-lucide="play" class="icon"></i> Run comparison</button>
                <button id="cmp-stop" class="cmp-btn cmp-btn-danger cmp-hidden" type="button"><i data-lucide="square" class="icon"></i> Stop</button>
                <button id="cmp-synth" class="cmp-btn" type="button" ${s.mode !== 'committee' ? 'disabled' : ''}><i data-lucide="git-merge" class="icon"></i> Synthesize</button>
                <span style="flex:1"></span>
                <span id="cmp-status-line" class="cmp-muted"></span>
                <button id="cmp-export-md" class="cmp-btn" type="button"><i data-lucide="download" class="icon"></i> Markdown</button>
                <button id="cmp-export-json" class="cmp-btn" type="button"><i data-lucide="braces" class="icon"></i> JSON</button>
                <button id="cmp-reopen" class="cmp-btn" type="button"><i data-lucide="messages-square" class="icon"></i> Reopen as chat</button>
            </div>

            <div id="cmp-results" class="cmp-results"></div>

            <div id="cmp-synthesis-wrap" class="cmp-section cmp-synthesis cmp-hidden">
                <div class="cmp-row" style="justify-content:space-between;margin-bottom:.6rem">
                    <h4 style="margin:0">Committee Synthesis</h4>
                    <span id="cmp-synth-status" class="cmp-badge skipped">skipped</span>
                </div>
                <div id="cmp-synth-body" class="cmp-synthesis-body"></div>
            </div>
        `;

        this._renderResults();
        this._renderSynthesis();
        this._patchSessionStatus({ status: s.status });
        this._bindDetailEvents();
        refreshIcons();
    }

    _entryConfigHtml(entry, index) {
        const limits = compareService.getEntryLimits();
        const models = this._modelsFor(entry.provider);
        return `
            <div class="cmp-entry-config" data-entry-id="${escapeHtml(entry.id)}">
                <div>
                    <span class="cmp-slot-tag">${slotLabel(index)}</span>
                    <select class="cmp-select cmp-entry-provider" aria-label="Provider">${providerOptions(entry.provider)}</select>
                </div>
                <select class="cmp-select cmp-entry-model" aria-label="Model">${modelOptions(models, entry.model)}</select>
                ${limits.min < this.active.entries.length
                    ? `<button class="cmp-icon-btn" data-remove-entry="${escapeHtml(entry.id)}" title="Remove slot" aria-label="Remove slot"><i data-lucide="x" class="icon"></i></button>`
                    : '<span></span>'}
            </div>
        `;
    }

    _bindDetailEvents() {
        const d = this.detail;

        // Prompt / system / advanced: update in-memory + debounced persist (no re-render)
        const schedulePersist = () => {
            clearTimeout(this._persistTimer);
            this._persistTimer = setTimeout(() => this._persistConfig(), 500);
        };
        d.querySelector('#cmp-prompt')?.addEventListener('input', schedulePersist);
        d.querySelector('#cmp-system')?.addEventListener('input', schedulePersist);
        d.querySelector('#cmp-temp')?.addEventListener('input', schedulePersist);
        d.querySelector('#cmp-maxctx')?.addEventListener('input', schedulePersist);

        // Blind toggle
        d.querySelector('#cmp-blind')?.addEventListener('change', async (e) => {
            const blind = e.target.checked;
            this.active = await compareService.update(this.activeId, { blind });
            if (!blind) await compareService.revealAll(this.activeId, true);
            this.active = await compareService.get(this.activeId);
            this._renderResults();
            this._renderList();
        });

        // Mode segmented control
        d.querySelector('#cmp-mode-compare')?.addEventListener('click', () => this._setMode('compare'));
        d.querySelector('#cmp-mode-committee')?.addEventListener('click', () => this._setMode('committee'));

        // Entry provider/model changes + remove
        d.querySelectorAll('.cmp-entry-provider').forEach(sel => {
            sel.addEventListener('change', (e) => this._onProviderChange(e.target.closest('[data-entry-id]').dataset.entryId, e.target.value));
        });
        d.querySelectorAll('.cmp-entry-model').forEach(sel => {
            sel.addEventListener('change', (e) => this._onModelChange(e.target.closest('[data-entry-id]').dataset.entryId, e.target.value));
        });
        d.querySelectorAll('[data-remove-entry]').forEach(btn => {
            btn.addEventListener('click', () => this._removeEntry(btn.dataset.removeEntry));
        });

        // Add entry
        d.querySelector('#cmp-add-entry')?.addEventListener('click', () => this._addEntry());

        // Actions
        d.querySelector('#cmp-run')?.addEventListener('click', () => this._run());
        d.querySelector('#cmp-stop')?.addEventListener('click', () => this._stop());
        d.querySelector('#cmp-synth')?.addEventListener('click', () => this._synthesize());
        d.querySelector('#cmp-export-md')?.addEventListener('click', () => this._export('markdown'));
        d.querySelector('#cmp-export-json')?.addEventListener('click', () => this._export('json'));
        d.querySelector('#cmp-reopen')?.addEventListener('click', () => this._reopen());

        // Rating (delegated) + reveal (delegated)
        d.querySelector('#cmp-results').addEventListener('click', (e) => {
            const rate = e.target.closest('[data-rate]');
            if (rate) {
                this._rate(rate.dataset.rate, parseInt(rate.dataset.value, 10));
                return;
            }
            const reveal = e.target.closest('[data-reveal]');
            if (reveal) {
                this._reveal(reveal.dataset.reveal);
            }
        });
    }

    async _setMode(mode) {
        if (!this.active || this.active.mode === mode) return;
        this.active = await compareService.update(this.activeId, { mode });
        this._renderDetail();
    }

    async _persistConfig() {
        if (!this.active) return;
        await this._collectConfig({ persist: true, reassign: true });
    }

    /**
     * Read editor inputs into this.active and optionally persist.
     * @param {Object} opts { persist:boolean, reassign:boolean }
     */
    async _collectConfig({ persist = true, reassign = true } = {}) {
        if (!this.active) return;
        const d = this.detail;
        const prompt = d.querySelector('#cmp-prompt')?.value ?? this.active.prompt;
        const systemPrompt = d.querySelector('#cmp-system')?.value ?? this.active.systemPrompt;
        const blind = d.querySelector('#cmp-blind')?.checked ?? this.active.blind;
        const temperatureRaw = parseFloat(d.querySelector('#cmp-temp')?.value);
        const maxCtxRaw = parseInt(d.querySelector('#cmp-maxctx')?.value, 10);
        const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : this.active.temperature;
        const maxCtx = Number.isFinite(maxCtxRaw) ? maxCtxRaw : this.active.maxCtx;

        const entries = [];
        d.querySelectorAll('[data-entry-id]').forEach(row => {
            const id = row.dataset.entryId;
            const existing = this.active.entries.find(e => e.id === id) || {};
            entries.push({
                id,
                provider: row.querySelector('.cmp-entry-provider')?.value || existing.provider,
                model: row.querySelector('.cmp-entry-model')?.value || existing.model
            });
        });

        if (!persist) {
            this.active.prompt = prompt;
            this.active.systemPrompt = systemPrompt;
            this.active.blind = blind;
            this.active.temperature = temperature;
            this.active.maxCtx = maxCtx;
            this.active.entries = this.active.entries.map(e => {
                const patch = entries.find(x => x.id === e.id);
                return patch ? { ...e, provider: patch.provider, model: patch.model } : e;
            });
            return;
        }

        const updated = await compareService.update(this.activeId, {
            prompt, systemPrompt, blind, temperature, maxCtx,
            mode: this.active.mode, entries
        });
        if (reassign) this.active = updated;
    }

    async _onProviderChange(entryId, providerName) {
        if (!this.active) return;
        await this._ensureModels(providerName);
        const entry = this.active.entries.find(e => e.id === entryId);
        if (!entry) return;
        const models = this._modelsFor(providerName);
        if (!entry.model || !models.includes(entry.model)) {
            entry.model = models[0] || entry.model;
        }
        await compareService.update(this.activeId, { entries: this.active.entries });
        this._renderEntriesOnly();
    }

    async _onModelChange(entryId, model) {
        if (!this.active) return;
        const entry = this.active.entries.find(e => e.id === entryId);
        if (!entry) return;
        entry.model = model;
        await compareService.update(this.activeId, { entries: this.active.entries });
    }

    async _addEntry() {
        if (!this.active) return;
        const limits = compareService.getEntryLimits();
        if (this.active.entries.length >= limits.max) return;
        const provider = providerManager.getProviderName() || 'ollama';
        await this._ensureModels(provider);
        const models = this._modelsFor(provider);
        const next = { provider, model: models[0] || null };
        const entries = [...this.active.entries.map(e => ({ id: e.id, provider: e.provider, model: e.model })), next];
        this.active = await compareService.update(this.activeId, { entries });
        this._renderDetail();
    }

    async _removeEntry(entryId) {
        if (!this.active) return;
        const limits = compareService.getEntryLimits();
        if (this.active.entries.length <= limits.min) {
            toast.warning(`Need at least ${limits.min} models to compare.`);
            return;
        }
        const entries = this.active.entries.filter(e => e.id !== entryId).map(e => ({ id: e.id, provider: e.provider, model: e.model }));
        this.active = await compareService.update(this.activeId, { entries });
        this._renderDetail();
    }

    _renderEntriesOnly() {
        const container = this.detail.querySelector('#cmp-entries');
        if (!container) return;
        container.innerHTML = this.active.entries.map((e, i) => this._entryConfigHtml(e, i)).join('');
        // Rebind entry-specific listeners
        container.querySelectorAll('.cmp-entry-provider').forEach(sel => {
            sel.addEventListener('change', (e) => this._onProviderChange(e.target.closest('[data-entry-id]').dataset.entryId, e.target.value));
        });
        container.querySelectorAll('.cmp-entry-model').forEach(sel => {
            sel.addEventListener('change', (e) => this._onModelChange(e.target.closest('[data-entry-id]').dataset.entryId, e.target.value));
        });
        container.querySelectorAll('[data-remove-entry]').forEach(btn => {
            btn.addEventListener('click', () => this._removeEntry(btn.dataset.removeEntry));
        });
        refreshIcons();
    }

    // ─── Run / stop / results ─────────────────────────────────────────────

    _setRunning(running) {
        this.detail.querySelector('#cmp-run')?.classList.toggle('cmp-hidden', running);
        this.detail.querySelector('#cmp-stop')?.classList.toggle('cmp-hidden', !running);
    }

    async _run() {
        if (!this.active) return;
        if (!this.active.prompt.trim()) {
            toast.warning('Enter a shared prompt before running.');
            this.detail.querySelector('#cmp-prompt')?.focus();
            return;
        }
        // Persist latest editor state, then re-read.
        await this._collectConfig({ persist: true, reassign: true });
        const invalidSlot = this.active.entries.find(e => !e.model);
        if (invalidSlot) {
            toast.warning('Every model slot needs a selected model.');
            return;
        }

        // Optimistically reset local entries to pending so cards render clean.
        this.active.entries.forEach(e => {
            e.status = 'pending'; e.content = ''; e.thinking = '';
            e.stats = null; e.error = null; e.simulated = false;
        });
        this._renderResults();
        this._renderSynthesis();
        this._setRunning(true);
        this._patchSessionStatus({ status: 'running' });
        const token = ++this._runToken;

        let finalSession = null;
        try {
            finalSession = await compareService.run(this.activeId, {
                onEntryStatus: (entry) => { if (token === this._runToken) this._patchResultStatus(entry); },
                onEntryChunk: (entry) => { if (token === this._runToken) this._patchResultContent(entry); },
                onSessionStatus: (session) => { if (token === this._runToken) this._patchSessionStatus(session); }
            });
        } catch (err) {
            console.error('[ComparePanel] run failed:', err);
            toast.error('Compare run failed: ' + (err.message || err));
        }

        // Use the live session returned by run() (avoids racing the coalesced IDB write).
        this.active = finalSession || await compareService.get(this.activeId);
        this._renderResults();
        this._renderSynthesis();
        this._setRunning(false);
        this._renderList();
        refreshIcons();
    }

    _stop() {
        compareService.stop(this.activeId);
        toast.info('Stopping in-flight responses…');
    }

    _renderResults() {
        const grid = this.detail.querySelector('#cmp-results');
        if (!grid || !this.active) return;
        const entries = this.active.entries || [];
        if (!entries.length) {
            grid.innerHTML = '<div class="cmp-empty">No model slots. Add at least two.</div>';
            return;
        }
        grid.innerHTML = entries.map((e, i) => this._resultCardHtml(e, i)).join('');
        refreshIcons();
    }

    _resultCardHtml(entry, index) {
        const blind = this.active.blind;
        const showIdentity = !blind || entry.revealed;
        const bodyHtml = this._entryBodyHtml(entry);
        const isStreaming = entry.status === 'streaming';
        return `
            <article class="cmp-result-card" data-result="${escapeHtml(entry.id)}">
                <header class="cmp-result-head">
                    <div class="cmp-result-label">
                        <span class="cmp-slot">${slotLabel(index)} ${showIdentity ? '' : `<span class="cmp-badge simulated" style="font-size:.62rem">hidden</span>`}</span>
                        <span class="cmp-model">${escapeHtml(modelDisplay(entry, blind))}</span>
                    </div>
                    ${badgeHtml(entry.status)}
                </header>
                <div class="cmp-result-body ${isStreaming ? 'cmp-streaming cmp-raw' : ''}">${bodyHtml}</div>
                <footer class="cmp-result-foot">
                    <span class="cmp-stats">${escapeHtml(statsText(entry))}</span>
                    ${starsHtml(entry.id, entry.rating)}
                    ${blind && !entry.revealed ? `<button class="cmp-icon-btn" data-reveal="${escapeHtml(entry.id)}" title="Reveal identity" aria-label="Reveal identity"><i data-lucide="eye" class="icon"></i></button>` : ''}
                </footer>
            </article>
        `;
    }

    _entryBodyHtml(entry) {
        if (entry.status === 'error') {
            return `<p class="cmp-error-text">${escapeHtml(entry.error || 'Error during generation.')}</p>`;
        }
        if (entry.status === 'pending' || entry.status === 'streaming') {
            return entry.content ? escapeHtml(entry.content) : '<span class="cmp-muted">Waiting for model…</span>';
        }
        if (!entry.content) return '<span class="cmp-muted">No content.</span>';
        let html = '';
        if (entry.thinking) {
            html += `<details class="cmp-thinking-wrap"><summary style="cursor:pointer">Thinking</summary><div class="cmp-thinking">${escapeHtml(entry.thinking)}</div></details>`;
        }
        html += renderMarkdown(entry.content);
        return html;
    }

    _patchResultContent(entry) {
        const card = this.detail.querySelector(`[data-result="${entry.id}"]`);
        if (!card) return;
        const body = card.querySelector('.cmp-result-body');
        if (!body) return;
        const streaming = entry.status === 'streaming' || entry.status === 'pending';
        if (streaming) {
            body.classList.add('cmp-raw');
            if (entry.content) body.textContent = entry.content;
            else body.innerHTML = '<span class="cmp-muted">Waiting for model…</span>';
        } else {
            body.classList.remove('cmp-raw');
            body.innerHTML = this._entryBodyHtml(entry);
        }
    }

    _patchResultStatus(entry) {
        const card = this.detail.querySelector(`[data-result="${entry.id}"]`);
        if (!card) return;
        const badge = card.querySelector('.cmp-badge');
        if (badge) {
            badge.className = `cmp-badge ${entry.status}`;
            badge.textContent = entry.status;
        }
        const body = card.querySelector('.cmp-result-body');
        if (body) {
            body.classList.toggle('cmp-streaming', entry.status === 'streaming');
            const streaming = entry.status === 'streaming' || entry.status === 'pending';
            body.classList.toggle('cmp-raw', streaming);
            if (streaming) {
                if (entry.content) body.textContent = entry.content;
                else body.innerHTML = '<span class="cmp-muted">Waiting for model…</span>';
            } else {
                body.innerHTML = this._entryBodyHtml(entry);
            }
        }
        const stats = card.querySelector('.cmp-stats');
        if (stats) stats.textContent = statsText(entry);
        const rating = card.querySelector('.cmp-rating');
        if (rating) {
            const tmp = document.createElement('span');
            tmp.innerHTML = starsHtml(entry.id, entry.rating);
            rating.replaceWith(tmp.firstElementChild);
        }
        refreshIcons();
    }

    _patchSessionStatus(session) {
        const line = this.detail.querySelector('#cmp-status-line');
        if (line) line.textContent = `Session: ${session.status || '—'}`;
    }

    async _rate(entryId, value) {
        if (!this.active) return;
        const entry = this.active.entries.find(e => e.id === entryId);
        if (!entry) return;
        // Toggle off if clicking the same star
        const next = entry.rating === value ? 0 : value;
        const updated = await compareService.setRating(this.activeId, entryId, next);
        if (updated) {
            entry.rating = updated.rating;
            entry.ratingNote = updated.ratingNote;
        }
        this._patchResultStatus(entry);
    }

    async _reveal(entryId) {
        if (!this.active) return;
        const entry = this.active.entries.find(e => e.id === entryId);
        if (!entry) return;
        await compareService.revealEntry(this.activeId, entryId, true);
        entry.revealed = true;
        this._patchResultStatus(entry);
        refreshIcons();
    }

    // ─── Synthesis ────────────────────────────────────────────────────────

    _renderSynthesis() {
        const wrap = this.detail.querySelector('#cmp-synthesis-wrap');
        if (!wrap || !this.active) return;
        const s = this.active.synthesis || { status: 'skipped', content: '' };
        const isCommittee = this.active.mode === 'committee';
        wrap.classList.toggle('cmp-hidden', !isCommittee && !s.content);

        const status = wrap.querySelector('#cmp-synth-status');
        if (status) { status.className = `cmp-badge ${s.status}`; status.textContent = s.status; }
        const body = wrap.querySelector('#cmp-synth-body');
        if (body) {
            body.classList.remove('cmp-raw');
            body.innerHTML = s.content
                ? renderMarkdown(s.content)
                : '<span class="cmp-muted">No synthesis yet — run the comparison, then click “Synthesize”.</span>';
        }

        const synthBtn = this.detail.querySelector('#cmp-synth');
        if (synthBtn) synthBtn.disabled = !isCommittee;
    }

    _patchSynthesis(synth) {
        const wrap = this.detail.querySelector('#cmp-synthesis-wrap');
        if (!wrap) return;
        wrap.classList.remove('cmp-hidden');
        const status = wrap.querySelector('#cmp-synth-status');
        if (status) { status.className = `cmp-badge ${synth.status}`; status.textContent = synth.status; }
        const body = wrap.querySelector('#cmp-synth-body');
        if (!body) return;
        if (synth.status === 'streaming') {
            body.classList.add('cmp-raw');
            body.textContent = synth.content || '';
        } else {
            body.classList.remove('cmp-raw');
            body.innerHTML = synth.content
                ? renderMarkdown(synth.content)
                : (synth.error
                    ? `<p class="cmp-error-text">${escapeHtml(synth.error)}</p>`
                    : '<span class="cmp-muted">No synthesis.</span>');
        }
    }

    async _synthesize() {
        if (!this.active) return;
        const usable = (this.active.entries || [])
            .filter(e => e.content && (e.status === 'completed' || e.status === 'simulated'));
        if (usable.length < 2) {
            toast.warning('Run the comparison first — need at least two responses to synthesize.');
            return;
        }
        this.detail.querySelector('#cmp-synth').disabled = true;
        const chairId = this.active.entries[0]?.id;
        let finalSession = null;
        try {
            finalSession = await compareService.runSynthesis(this.activeId, chairId, {
                onChunk: (synth) => this._patchSynthesis(synth),
                onStatus: (synth) => this._patchSynthesis(synth)
            });
        } catch (err) {
            console.error('[ComparePanel] synthesis failed:', err);
            toast.error('Synthesis failed: ' + (err.message || err));
        }
        this.active = finalSession || await compareService.get(this.activeId);
        this._renderSynthesis();
        this._renderList();
        refreshIcons();
    }

    // ─── Export / reopen ──────────────────────────────────────────────────

    _export(format) {
        if (!this.active) return;
        const { blob, filename } = compareService.exportBlob(this.active, format);
        this._download(blob, filename);
        toast.success(`Exported ${format.toUpperCase()}`);
    }

    _download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    _reopen() {
        if (!this.active) return;
        // Force a fresh read so the prompt/synthesis reflect the latest edits.
        compareService.get(this.activeId).then(session => {
            const prompt = compareService.makeReopenPrompt(session);
            const chatId = chatService.createChat({
                title: `Compare: ${session.title}`.slice(0, 60),
                mode: 'chat',
                messages: [{ role: 'user', content: prompt }]
            });
            chatService.selectChat(chatId);
            this.close();
            toast.success('Opened comparison as a chat');
        });
    }
}

export function createComparePanel() {
    return new ComparePanel();
}

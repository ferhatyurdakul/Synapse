import { deepResearchService } from '../services/deepResearchService.js';
import { escapeHtml } from '../utils/markdown.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { toast } from './toast.js';

function formatDate(value) {
    return value ? new Date(value).toLocaleString() : 'unknown';
}

function statusLabel(value) {
    return String(value || 'unknown').replace(/-/g, ' ');
}

class DeepResearchPanel {
    constructor() {
        this.opened = false;
        this.runs = [];
        this.activeId = null;
        this.activeSources = [];
        this.running = false;
        this._renderShell();
        eventBus.on(Events.DEEP_RESEARCH_UPDATED, event => {
            if (!this.opened) return;
            if (event?.runId && (!this.activeId || this.activeId === event.runId)) this.activeId = event.runId;
            this._load();
        });
    }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'deep-research-modal';
        modal.className = 'deep-research-modal';
        modal.innerHTML = `
            <div class="deep-research-overlay"></div>
            <div class="deep-research-panel">
                <header class="deep-research-header">
                    <div>
                        <h2><i data-lucide="search-check" class="icon"></i> Deep Research</h2>
                        <p>Plan, search, read, deduplicate sources, and synthesize a cited report with visible progress.</p>
                    </div>
                    <button class="deep-research-close" id="deep-research-close-btn" type="button" aria-label="Close Deep Research">&times;</button>
                </header>
                <div class="deep-research-body">
                    <aside class="deep-research-sidebar">
                        <form id="deep-research-form" class="deep-research-form">
                            <label for="deep-research-query">Research question</label>
                            <textarea id="deep-research-query" rows="5" placeholder="What should Synapse investigate deeply?"></textarea>
                            <div class="deep-research-limit-grid">
                                <label>Searches <input id="deep-research-max-searches" type="number" min="1" max="8" value="4"></label>
                                <label>Sources <input id="deep-research-max-sources" type="number" min="1" max="20" value="8"></label>
                                <label>Chars/source <input id="deep-research-max-chars" type="number" min="1200" max="30000" step="500" value="9000"></label>
                                <label>Timeout ms <input id="deep-research-timeout" type="number" min="2500" max="30000" step="500" value="9000"></label>
                            </div>
                            <label class="deep-research-select-label">Report format
                                <select id="deep-research-format">
                                    <option value="technical">Technical report</option>
                                    <option value="summary">Executive summary</option>
                                    <option value="comparison">Comparison</option>
                                    <option value="recommendation">Recommendation</option>
                                </select>
                            </label>
                            <label class="deep-research-checkbox"><input id="deep-research-second-pass" type="checkbox" checked> Run gap analysis + second pass when needed</label>
                            <button id="deep-research-start" class="deep-research-primary" type="submit"><i data-lucide="rocket" class="icon"></i> Start Research</button>
                        </form>
                        <div class="deep-research-history-head">
                            <h3>Runs</h3>
                            <button id="deep-research-refresh" type="button"><i data-lucide="refresh-cw" class="icon"></i></button>
                        </div>
                        <div id="deep-research-run-list" class="deep-research-run-list"></div>
                    </aside>
                    <section id="deep-research-detail" class="deep-research-empty">
                        <div><h3>No run selected</h3><p>Start a Deep Research run or reopen a past one.</p></div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindEvents();
    }

    _bindEvents() {
        this.modal.querySelector('#deep-research-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.deep-research-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#deep-research-refresh').addEventListener('click', () => this._load());
        this.modal.querySelector('#deep-research-form').addEventListener('submit', event => this._start(event));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.opened) this.close();
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

    async _start(event) {
        event.preventDefault();
        if (this.running) return;
        const query = this.modal.querySelector('#deep-research-query').value.trim();
        const limits = {
            maxSearches: Number(this.modal.querySelector('#deep-research-max-searches').value) || 4,
            maxSources: Number(this.modal.querySelector('#deep-research-max-sources').value) || 8,
            maxCharsPerSource: Number(this.modal.querySelector('#deep-research-max-chars').value) || 9000,
            fetchTimeoutMs: Number(this.modal.querySelector('#deep-research-timeout').value) || 9000,
            enableSecondPass: this.modal.querySelector('#deep-research-second-pass').checked,
            reportFormat: this.modal.querySelector('#deep-research-format').value || 'technical'
        };
        try {
            this.running = true;
            this.modal.querySelector('#deep-research-start').disabled = true;
            toast.info('Deep Research started');
            const run = await deepResearchService.startRun(query, { limits });
            this.activeId = run.id;
            await this._load();
            toast.success('Deep Research report saved');
        } catch (err) {
            console.error('[DeepResearchPanel] run failed:', err);
            toast.error(err.message || 'Deep Research failed');
            await this._load();
        } finally {
            this.running = false;
            this.modal.querySelector('#deep-research-start').disabled = false;
        }
    }

    async _load() {
        try {
            this.runs = await deepResearchService.listRuns();
            if (!this.activeId && this.runs.length) this.activeId = this.runs[0].id;
            this.activeSources = this.activeId ? await deepResearchService.getSources(this.activeId) : [];
        } catch (err) {
            console.error('[DeepResearchPanel] load failed:', err);
            toast.error('Could not load Deep Research runs');
            this.runs = [];
            this.activeSources = [];
        }
        this._renderList();
        await this._renderDetail();
        refreshIcons();
    }

    _renderList() {
        const list = this.modal.querySelector('#deep-research-run-list');
        if (!this.runs.length) {
            list.innerHTML = '<div class="deep-research-empty-card">No research runs yet.</div>';
            return;
        }
        list.innerHTML = this.runs.map(run => `
            <article class="deep-research-run-card ${run.id === this.activeId ? 'active' : ''}" data-run-id="${run.id}">
                <strong>${escapeHtml(run.title || run.query)}</strong>
                <span>${escapeHtml(statusLabel(run.status))} · ${formatDate(run.updatedAt)}</span>
                <small>${escapeHtml(run.query)}</small>
            </article>
        `).join('');
        list.querySelectorAll('[data-run-id]').forEach(card => card.addEventListener('click', async () => {
            this.activeId = card.dataset.runId;
            this.activeSources = await deepResearchService.getSources(this.activeId);
            this._renderList();
            await this._renderDetail();
            refreshIcons();
        }));
    }

    async _renderDetail() {
        const detail = this.modal.querySelector('#deep-research-detail');
        const run = this.activeId ? await deepResearchService.getRun(this.activeId) : null;
        if (!run) {
            detail.className = 'deep-research-empty';
            detail.innerHTML = '<div><h3>No run selected</h3><p>Start a Deep Research run or reopen a past one.</p></div>';
            return;
        }
        detail.className = 'deep-research-detail';
        const steps = (run.steps || []).map(step => `
            <li class="deep-research-step ${escapeHtml(step.status)}">
                <span></span><div><strong>${escapeHtml(statusLabel(step.name))}</strong><p>${escapeHtml(step.message || '')}</p><small>${escapeHtml(statusLabel(step.status))} · ${formatDate(step.updatedAt)}</small></div>
            </li>
        `).join('') || '<li class="deep-research-step"><span></span><div><strong>Waiting</strong><p>No steps recorded yet.</p></div></li>';
        const plan = (run.plan || []).map(item => `<li><strong>${escapeHtml(item.subquestion)}</strong><br><span>${escapeHtml(item.searchQuery)} · ${escapeHtml(statusLabel(item.status))}</span></li>`).join('') || '<li>No plan recorded.</li>';
        const sources = this.activeSources.map((source, index) => `
            <article class="deep-research-source">
                <div><strong>[${index + 1}] ${escapeHtml(source.title)}</strong><span>${escapeHtml(statusLabel(source.status))} · ${source.wordCount || 0} words</span></div>
                ${source.url ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">open</a>` : ''}
                <p>${escapeHtml(source.excerpt || source.snippet || source.error || 'No excerpt.')}</p>
            </article>
        `).join('') || '<p class="deep-research-muted">No sources stored yet.</p>';
        detail.innerHTML = `
            <div class="deep-research-detail-header">
                <div>
                    <h3>${escapeHtml(run.title || run.query)}</h3>
                    <p>${escapeHtml(run.query)}</p>
                    <div class="deep-research-badges">
                        <span>${escapeHtml(statusLabel(run.status))}</span>
                        <span>${(run.sourceIds || []).length} sources</span>
                        <span>${formatDate(run.createdAt)}</span>
                        ${run.reportId ? `<span>Report: ${escapeHtml(run.reportId)}</span>` : ''}
                    </div>
                </div>
                <div class="deep-research-actions">
                    <button data-action="copy-report" type="button"><i data-lucide="copy" class="icon"></i> Copy Report</button>
                    <button data-action="export-md" type="button"><i data-lucide="download" class="icon"></i> Export MD</button>
                    <button data-action="export-json" type="button"><i data-lucide="braces" class="icon"></i> Export JSON</button>
                    <button data-action="delete-run" type="button"><i data-lucide="trash-2" class="icon"></i> Delete</button>
                </div>
            </div>
            ${run.error ? `<div class="deep-research-error">${escapeHtml(run.error)}</div>` : ''}
            <div class="deep-research-columns">
                <section><h4>Progress Timeline</h4><ol class="deep-research-timeline">${steps}</ol></section>
                <section><h4>Research Plan</h4><ul class="deep-research-plan">${plan}</ul></section>
            </div>
            <section><h4>Sources</h4><div class="deep-research-sources">${sources}</div></section>
            <section><h4>Final Report</h4><pre class="deep-research-report">${escapeHtml(run.report || 'Report will appear after synthesis.')}</pre></section>
        `;
        detail.querySelector('[data-action="copy-report"]').addEventListener('click', () => this._copyReport(run));
        detail.querySelector('[data-action="export-md"]').addEventListener('click', () => this._exportRun(run, 'markdown'));
        detail.querySelector('[data-action="export-json"]').addEventListener('click', () => this._exportRun(run, 'json'));
        detail.querySelector('[data-action="delete-run"]').addEventListener('click', () => this._deleteRun(run.id));
    }

    async _copyReport(run) {
        await navigator.clipboard.writeText(run.report || '');
        toast.success('Research report copied');
    }

    async _exportRun(run, format) {
        const body = await deepResearchService.exportRun(run.id, format);
        const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${(run.title || 'deep-research').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.${format === 'json' ? 'json' : 'md'}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        toast.success(`Deep Research ${format === 'json' ? 'JSON' : 'Markdown'} exported`);
    }

    async _deleteRun(runId) {
        if (!confirm('Delete this Deep Research run? The saved report library entry is preserved.')) return;
        await deepResearchService.deleteRun(runId);
        this.activeId = null;
        await this._load();
        toast.success('Deep Research run deleted');
    }
}

export function createDeepResearchPanel() {
    return new DeepResearchPanel();
}

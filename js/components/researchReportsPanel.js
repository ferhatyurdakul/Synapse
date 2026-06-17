import { researchReportService, REPORT_STATUSES, SOURCE_TYPES } from '../services/researchReportService.js';
import { chatService } from '../services/chatService.js';
import { escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

function formatDate(value) {
    return value ? new Date(value).toLocaleString() : 'unknown';
}

function optionList(values, selected = '') {
    return values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}

function listItems(values, empty = 'None recorded.') {
    if (!values?.length) return `<p class="report-muted">${empty}</p>`;
    return `<ul>${values.map(value => `<li>${escapeHtml(typeof value === 'string' ? value : value.text || JSON.stringify(value))}</li>`).join('')}</ul>`;
}

class ResearchReportsPanel {
    constructor() {
        this.opened = false;
        this.reports = [];
        this.activeId = null;
        this.filters = {
            query: '',
            topic: '',
            projectId: '',
            sourceType: '',
            status: '',
            minConfidence: '',
            fromDate: '',
            toDate: '',
            includeArchived: false
        };
        this._renderShell();
    }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'research-reports-modal';
        modal.className = 'report-modal';
        modal.innerHTML = `
            <div class="report-overlay"></div>
            <div class="report-panel">
                <header class="report-header">
                    <div>
                        <h2><i data-lucide="library" class="icon"></i> Research Reports</h2>
                        <p>Durable Deep Research outputs with sources, notes, synthesis, tags, provenance, export, and follow-up runs.</p>
                    </div>
                    <button class="report-close" id="report-close-btn" type="button">&times;</button>
                </header>
                <div class="report-body">
                    <aside class="report-library">
                        <div class="report-toolbar">
                            <input id="report-search" type="search" placeholder="Search reports, sources, citations..." autocomplete="off">
                            <input id="report-topic" type="search" placeholder="Topic filter">
                            <input id="report-project" type="search" placeholder="Project">
                            <select id="report-status"><option value="">Any state</option>${optionList(REPORT_STATUSES)}</select>
                            <select id="report-source-type"><option value="">Any source</option>${optionList(SOURCE_TYPES)}</select>
                            <input id="report-confidence" type="number" min="0" max="1" step="0.05" placeholder="Min confidence">
                            <input id="report-from" type="date" title="From date">
                            <input id="report-to" type="date" title="To date">
                            <label class="report-check"><input id="report-archived" type="checkbox"> Archived</label>
                        </div>
                        <div class="report-create-row">
                            <button id="report-new-btn" class="report-primary" type="button"><i data-lucide="plus" class="icon"></i> Add Report</button>
                            <button id="report-import-btn" type="button"><i data-lucide="upload" class="icon"></i> Import JSON</button>
                            <input id="report-import-input" type="file" class="hidden" accept=".json,application/json">
                        </div>
                        <div id="report-list" class="report-list"></div>
                    </aside>
                    <section id="report-detail" class="report-detail-empty">
                        <div><h3>No report selected</h3><p>Choose a report or add a completed Deep Research run.</p></div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindEvents();
    }

    _bindEvents() {
        this.modal.querySelector('#report-close-btn').addEventListener('click', () => this.close());
        this.modal.querySelector('.report-overlay').addEventListener('click', () => this.close());
        const bindings = [
            ['report-search', 'query'], ['report-topic', 'topic'], ['report-project', 'projectId'],
            ['report-status', 'status'], ['report-source-type', 'sourceType'], ['report-confidence', 'minConfidence'],
            ['report-from', 'fromDate'], ['report-to', 'toDate']
        ];
        bindings.forEach(([id, key]) => {
            this.modal.querySelector(`#${id}`).addEventListener('input', e => {
                this.filters[key] = e.target.value;
                this._load();
            });
            this.modal.querySelector(`#${id}`).addEventListener('change', e => {
                this.filters[key] = e.target.value;
                this._load();
            });
        });
        this.modal.querySelector('#report-archived').addEventListener('change', e => {
            this.filters.includeArchived = e.target.checked;
            this._load();
        });
        this.modal.querySelector('#report-new-btn').addEventListener('click', () => this._createDraft());
        this.modal.querySelector('#report-import-btn').addEventListener('click', () => this.modal.querySelector('#report-import-input').click());
        this.modal.querySelector('#report-import-input').addEventListener('change', e => this._importJson(e.target.files?.[0]));
        document.addEventListener('keydown', e => {
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

    async _load() {
        try {
            this.reports = await researchReportService.list(this.filters);
        } catch (err) {
            console.error('[ResearchReportsPanel] load failed:', err);
            toast.error('Could not load research reports');
            this.reports = [];
        }
        this._renderList();
        await this._renderDetail();
    }

    _renderList() {
        const list = this.modal.querySelector('#report-list');
        if (!this.reports.length) {
            list.innerHTML = '<div class="report-empty">No matching reports yet.</div>';
            return;
        }
        list.innerHTML = this.reports.map(report => `
            <article class="report-card ${report.id === this.activeId ? 'active' : ''}" data-open-report="${report.id}">
                <div class="report-card-main">
                    <strong>${escapeHtml(report.title)}</strong>
                    <span>${escapeHtml(report.topic || report.query || 'untitled')} · ${escapeHtml(report.status || report.state || 'unknown')}</span>
                    <small>${escapeHtml(report.projectId || 'default')} · ${(report.tags || []).map(escapeHtml).join(', ') || 'no tags'} · ${formatDate(report.createdAt)}</small>
                </div>
                <div class="report-card-actions">
                    <button data-export-report="${report.id}" title="Export Markdown"><i data-lucide="download" class="icon"></i></button>
                    <button data-archive-report="${report.id}" title="Archive/unarchive"><i data-lucide="archive" class="icon"></i></button>
                </div>
            </article>
        `).join('');
        list.querySelectorAll('[data-open-report]').forEach(card => card.addEventListener('click', e => {
            if (e.target.closest('button')) return;
            this.activeId = card.dataset.openReport;
            this._renderList();
            this._renderDetail();
        }));
        list.querySelectorAll('[data-export-report]').forEach(btn => btn.addEventListener('click', e => this._export(e.currentTarget.dataset.exportReport, 'markdown')));
        list.querySelectorAll('[data-archive-report]').forEach(btn => btn.addEventListener('click', e => this._archive(e.currentTarget.dataset.archiveReport)));
        refreshIcons();
    }

    async _renderDetail() {
        const detail = this.modal.querySelector('#report-detail');
        const report = this.activeId ? await researchReportService.get(this.activeId) : null;
        if (!report) {
            detail.className = 'report-detail-empty';
            detail.innerHTML = '<div><h3>No report selected</h3><p>Choose a report or add a completed Deep Research run.</p></div>';
            return;
        }
        const sources = (report.sources || []).map(source => `
            <li><strong>${escapeHtml(source.title)}</strong> <span>${escapeHtml(source.type)}</span>${source.url ? ` <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">open</a>` : ''}<p>${escapeHtml(source.notes || '')}</p></li>
        `).join('') || '<li>No sources recorded.</li>';
        detail.className = 'report-detail';
        detail.innerHTML = `
            <div class="report-detail-header">
                <div>
                    <h3>${escapeHtml(report.title)}</h3>
                    <p>${escapeHtml(report.query || '')}</p>
                    <div class="report-badges">
                        <span>${escapeHtml(report.mode || 'deep-research')}</span>
                        <span>${escapeHtml(report.status || report.state || 'completed')}</span>
                        <span>${escapeHtml(report.projectId || 'default')}</span>
                        <span>${formatDate(report.createdAt)}</span>
                    </div>
                </div>
                <div class="report-actions">
                    <button data-action="export-md"><i data-lucide="download" class="icon"></i> Markdown</button>
                    <button data-action="export-html"><i data-lucide="file-code" class="icon"></i> HTML</button>
                    <button data-action="print"><i data-lucide="printer" class="icon"></i> Print/PDF</button>
                    <button data-action="reopen" class="report-primary"><i data-lucide="refresh-cw" class="icon"></i> Reopen Research</button>
                </div>
            </div>
            <section><h4>Tags</h4><p>${(report.tags || []).map(tag => `<span class="report-tag">${escapeHtml(tag)}</span>`).join('') || '<span class="report-muted">No tags.</span>'}</p></section>
            <section><h4>Provenance</h4><p>Run: ${escapeHtml(report.sourceRunId || 'none')} · Session: ${escapeHtml(report.sourceSessionId || 'none')} · Chat: ${escapeHtml(report.sourceChatId || 'none')}</p></section>
            <section><h4>Sources</h4><ul class="report-sources">${sources}</ul></section>
            <section><h4>Extracted Notes</h4>${listItems(report.extractedNotes, 'No extracted notes.')}</section>
            <section><h4>Intermediate Findings</h4>${listItems(report.intermediateFindings, 'No intermediate findings.')}</section>
            <section><h4>Final Synthesis</h4><pre>${escapeHtml(report.finalSynthesis || report.body || '')}</pre></section>
            <section><h4>Report Body</h4><pre>${escapeHtml(report.body || report.finalSynthesis || '')}</pre></section>
        `;
        detail.querySelector('[data-action="export-md"]').addEventListener('click', () => this._export(report.id, 'markdown'));
        detail.querySelector('[data-action="export-html"]').addEventListener('click', () => this._export(report.id, 'html'));
        detail.querySelector('[data-action="print"]').addEventListener('click', () => this._print(report));
        detail.querySelector('[data-action="reopen"]').addEventListener('click', () => this._reopen(report));
        refreshIcons();
    }

    async _createDraft() {
        const report = await researchReportService.saveFromDeepResearchRun({
            title: 'Untitled Research Report',
            query: 'Describe the research question here',
            topic: 'General research',
            tags: ['research'],
            status: 'draft',
            sources: [],
            extractedNotes: [],
            intermediateFindings: [],
            body: 'Paste or import a completed Deep Research report here.',
            finalSynthesis: ''
        });
        this.activeId = report.id;
        await this._load();
        toast.success('Research report created');
    }

    async _importJson(file) {
        if (!file) return;
        try {
            const payload = JSON.parse(await file.text());
            const report = await researchReportService.saveFromDeepResearchRun(payload.report || payload);
            this.modal.querySelector('#report-import-input').value = '';
            this.activeId = report.id;
            await this._load();
            toast.success('Research report imported');
        } catch (err) {
            console.error('[ResearchReportsPanel] import failed:', err);
            toast.error('Could not import report JSON');
        }
    }

    async _archive(reportId) {
        const report = await researchReportService.get(reportId);
        await researchReportService.archive(reportId, !report.archived);
        await this._load();
    }

    async _export(reportId, format) {
        const report = await researchReportService.get(reportId);
        const { blob, filename } = researchReportService.exportBlob(report, format);
        this._download(blob, filename);
    }

    _print(report) {
        const html = researchReportService.exportHtml(report);
        const win = window.open('', '_blank', 'noopener,noreferrer');
        if (!win) {
            toast.warning('Popup blocked; export HTML instead.');
            return;
        }
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
    }

    _reopen(report) {
        const prompt = researchReportService.makeFollowUpPrompt(report);
        const chatId = chatService.createChat({ title: `Follow-up: ${report.title}`, mode: 'research', messages: [{ role: 'user', content: prompt }] });
        chatService.selectChat(chatId);
        this.close();
        toast.success('Opened follow-up research chat');
    }

    _download(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }
}

export function createResearchReportsPanel() {
    return new ResearchReportsPanel();
}

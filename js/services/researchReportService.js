import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';

const REPORT_STATUSES = ['draft', 'completed', 'reviewed', 'archived'];
const SOURCE_TYPES = ['web', 'paper', 'vault', 'chat', 'file', 'api', 'manual'];

function now() {
    return new Date().toISOString();
}

function id(prefix = 'report') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function slug(value) {
    return String(value || 'research-report')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'research-report';
}

function parseList(value) {
    if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function normalizeSource(source = {}) {
    return {
        id: source.id || id('src'),
        title: source.title || source.url || source.type || 'Untitled source',
        url: source.url || '',
        type: SOURCE_TYPES.includes(source.type) ? source.type : 'manual',
        confidence: Number.isFinite(Number(source.confidence)) ? Number(source.confidence) : null,
        notes: source.notes || source.snippet || ''
    };
}

function normalizeReport(input = {}) {
    const timestamp = now();
    const sources = Array.isArray(input.sources) ? input.sources.map(normalizeSource) : [];
    const extractedNotes = Array.isArray(input.extractedNotes)
        ? input.extractedNotes.map(note => typeof note === 'string' ? { text: note, sourceId: null } : { text: note.text || '', sourceId: note.sourceId || null })
        : [];
    const citations = Array.isArray(input.citations) ? input.citations : [];
    const visuals = Array.isArray(input.visuals) ? input.visuals : [];
    const topic = input.topic || input.query || input.title || 'General research';
    return {
        id: input.id || id('report'),
        title: (input.title || topic || 'Untitled Research Report').trim(),
        query: input.query || topic,
        mode: input.mode || 'deep-research',
        projectId: input.projectId || input.project || 'default',
        topic,
        tags: parseList(input.tags),
        status: REPORT_STATUSES.includes(input.status) ? input.status : 'completed',
        confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : null,
        state: input.state || input.status || 'completed',
        sourceChatId: input.sourceChatId || input.chatId || null,
        sourceSessionId: input.sourceSessionId || input.sessionId || null,
        sourceRunId: input.sourceRunId || input.runId || null,
        sources,
        extractedNotes,
        intermediateFindings: Array.isArray(input.intermediateFindings) ? input.intermediateFindings : parseList(input.intermediateFindings),
        body: input.body || input.reportBody || input.content || '',
        finalSynthesis: input.finalSynthesis || input.synthesis || input.body || input.reportBody || '',
        citations,
        visuals,
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp,
        completedAt: input.completedAt || timestamp,
        archived: Boolean(input.archived) || input.status === 'archived'
    };
}

function searchText(report) {
    return [
        report.title,
        report.query,
        report.mode,
        report.projectId,
        report.topic,
        report.status,
        report.state,
        ...(report.tags || []),
        ...(report.sources || []).flatMap(source => [source.title, source.url, source.type, source.notes]),
        ...(report.extractedNotes || []).map(note => note.text),
        ...(report.intermediateFindings || []),
        report.body,
        report.finalSynthesis
    ].join(' ').toLowerCase();
}

class ResearchReportService {
    listStatuses() {
        return REPORT_STATUSES;
    }

    listSourceTypes() {
        return SOURCE_TYPES;
    }

    async list(filters = {}) {
        let reports = await getAllRecords('researchReports');
        const query = String(filters.query || '').trim().toLowerCase();
        const includeArchived = Boolean(filters.includeArchived);
        const from = filters.fromDate ? new Date(filters.fromDate).toISOString() : null;
        const to = filters.toDate ? new Date(`${filters.toDate}T23:59:59`).toISOString() : null;

        reports = reports.filter(report => includeArchived || !report.archived);
        if (filters.status) reports = reports.filter(report => report.status === filters.status || report.state === filters.status);
        if (filters.projectId) reports = reports.filter(report => report.projectId === filters.projectId);
        if (filters.topic) reports = reports.filter(report => String(report.topic || '').toLowerCase().includes(String(filters.topic).toLowerCase()));
        if (filters.tag) reports = reports.filter(report => (report.tags || []).includes(filters.tag));
        if (filters.sourceType) reports = reports.filter(report => (report.sources || []).some(source => source.type === filters.sourceType));
        if (filters.minConfidence) reports = reports.filter(report => Number(report.confidence || 0) >= Number(filters.minConfidence));
        if (from) reports = reports.filter(report => (report.createdAt || '') >= from);
        if (to) reports = reports.filter(report => (report.createdAt || '') <= to);
        if (query) reports = reports.filter(report => searchText(report).includes(query));

        reports.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return reports;
    }

    async get(reportId) {
        return getRecord('researchReports', reportId);
    }

    async save(input = {}) {
        const report = normalizeReport(input);
        await putRecord('researchReports', report);
        await this._upsertRagShadow(report);
        return report;
    }

    async update(reportId, patch = {}) {
        const existing = await this.get(reportId);
        if (!existing) throw new Error(`Research report not found: ${reportId}`);
        const report = normalizeReport({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt });
        await putRecord('researchReports', report);
        await this._upsertRagShadow(report);
        return report;
    }

    async archive(reportId, archived = true) {
        return this.update(reportId, { archived, status: archived ? 'archived' : 'completed' });
    }

    async delete(reportId) {
        await deleteRecord('researchReports', reportId);
    }

    async saveFromDeepResearchRun(run = {}) {
        return this.save({
            title: run.title || run.topic || run.query,
            query: run.query || run.topic,
            mode: run.mode || 'deep-research',
            projectId: run.projectId || run.project,
            topic: run.topic || run.query,
            tags: run.tags,
            status: run.status === 'failed' ? 'draft' : 'completed',
            confidence: run.confidence,
            state: run.status || run.state || 'completed',
            sourceRunId: run.runId || run.id,
            sourceSessionId: run.sessionId,
            sourceChatId: run.chatId,
            sources: run.sources,
            extractedNotes: run.extractedNotes || run.notes,
            intermediateFindings: run.intermediateFindings || run.findings,
            body: run.report || run.body || run.content,
            finalSynthesis: run.finalSynthesis || run.synthesis,
            citations: run.citations,
            visuals: run.visuals,
            completedAt: run.completedAt,
            createdAt: run.createdAt
        });
    }

    exportMarkdown(report) {
        const sources = (report.sources || []).map((source, index) => `${index + 1}. ${source.title}${source.url ? ` — ${source.url}` : ''}${source.confidence !== null ? ` (confidence ${source.confidence})` : ''}`).join('\n') || 'No sources recorded.';
        const notes = (report.extractedNotes || []).map(note => `- ${note.text}${note.sourceId ? ` (source: ${note.sourceId})` : ''}`).join('\n') || 'No extracted notes recorded.';
        const findings = (report.intermediateFindings || []).map(finding => `- ${finding}`).join('\n') || 'No intermediate findings recorded.';
        const citations = (report.citations || []).map(citation => `- ${typeof citation === 'string' ? citation : JSON.stringify(citation)}`).join('\n') || 'No citations recorded.';
        return `# ${report.title}\n\n- Query: ${report.query || ''}\n- Mode: ${report.mode || ''}\n- Project: ${report.projectId || ''}\n- Topic: ${report.topic || ''}\n- Status: ${report.status || report.state || ''}\n- Tags: ${(report.tags || []).join(', ') || 'none'}\n- Created: ${report.createdAt || ''}\n- Source chat: ${report.sourceChatId || 'none'}\n- Source run: ${report.sourceRunId || 'none'}\n\n## Sources\n${sources}\n\n## Extracted Notes\n${notes}\n\n## Intermediate Findings\n${findings}\n\n## Final Synthesis\n${report.finalSynthesis || report.body || ''}\n\n## Report Body\n${report.body || report.finalSynthesis || ''}\n\n## Citations\n${citations}\n`;
    }

    exportHtml(report) {
        const markdown = this.exportMarkdown(report)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `<!doctype html><html><head><meta charset="utf-8"><title>${report.title}</title><style>body{font:16px system-ui;line-height:1.55;max-width:880px;margin:3rem auto;padding:0 1rem}pre{white-space:pre-wrap} @media print{body{margin:1rem}}</style></head><body><pre>${markdown}</pre></body></html>`;
    }

    exportBlob(report, format = 'markdown') {
        if (format === 'html') {
            return { blob: new Blob([this.exportHtml(report)], { type: 'text/html' }), filename: `${slug(report.title)}.html` };
        }
        if (format === 'json') {
            return { blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), filename: `${slug(report.title)}.json` };
        }
        return { blob: new Blob([this.exportMarkdown(report)], { type: 'text/markdown' }), filename: `${slug(report.title)}.md` };
    }

    makeFollowUpPrompt(report) {
        return `Reopen this saved research report as an active follow-up research run.\n\nOriginal title: ${report.title}\nOriginal query: ${report.query}\nProject: ${report.projectId}\nTags: ${(report.tags || []).join(', ')}\nSource report ID: ${report.id}\nSource chat: ${report.sourceChatId || 'none'}\n\nUse the prior synthesis as context, verify stale claims, preserve provenance, and continue with a sharper follow-up question.\n\nPrior synthesis:\n${report.finalSynthesis || report.body || ''}`;
    }

    async _upsertRagShadow(report) {
        try {
            await putRecord('ragCollections', { id: 'research-report-library', name: 'Research Report Library', createdAt: report.createdAt, updatedAt: report.updatedAt });
            await putRecord('ragDocuments', {
                id: `reportlib:${report.id}`,
                collectionId: 'research-report-library',
                title: report.title,
                content: this.exportMarkdown(report),
                metadata: { source: 'research-report-library', mode: report.mode, tags: report.tags, status: report.status, projectId: report.projectId },
                createdAt: report.createdAt,
                updatedAt: report.updatedAt
            });
        } catch (err) {
            console.warn('[ResearchReportService] RAG shadow update skipped:', err);
        }
    }
}

export const researchReportService = new ResearchReportService();
export { REPORT_STATUSES, SOURCE_TYPES };

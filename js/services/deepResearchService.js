import { putRecord, getRecord, getAllRecords, getRecordsByIndex, deleteRecord } from './idbStore.js';
import { researchReportService } from './researchReportService.js';
import { storageService } from './storageService.js';
import { eventBus, Events } from '../utils/eventBus.js';

const DEFAULT_LIMITS = {
    maxSearches: 4,
    maxResultsPerSearch: 5,
    maxSources: 8,
    maxCharsPerSource: 9000,
    fetchTimeoutMs: 9000
};

function now() {
    return new Date().toISOString();
}

function id(prefix = 'research') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeUrl(value = '') {
    try {
        const url = new URL(value);
        url.hash = '';
        if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
        return url.toString().toLowerCase();
    } catch {
        return String(value || '').trim().toLowerCase();
    }
}

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function titleCase(value = '') {
    return String(value || '')
        .trim()
        .split(/\s+/)
        .slice(0, 12)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ') || 'Deep Research Run';
}

function sentenceScore(text = '') {
    const value = text.toLowerCase();
    const signals = ['because', 'evidence', 'study', 'report', 'analysis', 'shows', 'according', 'data', 'estimate', 'risk', 'benefit'];
    return signals.reduce((score, signal) => score + (value.includes(signal) ? 1 : 0), 0) + Math.min(4, text.length / 220);
}

class DeepResearchService {
    constructor() {
        this.activeRunId = null;
    }

    async init() {
        // Touching the DB through storageService init is handled by App; this method exists for symmetry.
        return true;
    }

    getLimits(overrides = {}) {
        const settings = storageService.loadSettings?.() || {};
        return {
            ...DEFAULT_LIMITS,
            ...settings.deepResearchLimits,
            ...overrides
        };
    }

    async listRuns() {
        const runs = await getAllRecords('deepResearchRuns');
        return runs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    async getRun(runId) {
        return getRecord('deepResearchRuns', runId);
    }

    async getSources(runId) {
        const sources = await getRecordsByIndex('deepResearchSources', 'runId', runId);
        return sources.sort((a, b) => Number(a.rank || 0) - Number(b.rank || 0));
    }

    async deleteRun(runId) {
        const sources = await this.getSources(runId);
        await Promise.all(sources.map(source => deleteRecord('deepResearchSources', source.id)));
        await deleteRecord('deepResearchRuns', runId);
        eventBus.emit(Events.DEEP_RESEARCH_UPDATED, { runId, action: 'deleted' });
    }

    async startRun(query, options = {}) {
        const cleanedQuery = normalizeText(query);
        if (!cleanedQuery) throw new Error('Enter a research question first.');

        const timestamp = now();
        const run = {
            id: id('drun'),
            query: cleanedQuery,
            title: options.title || titleCase(cleanedQuery),
            status: 'running',
            mode: 'deep-research',
            projectId: options.projectId || 'default',
            steps: [],
            plan: [],
            searches: [],
            sourceIds: [],
            notes: [],
            findings: [],
            report: '',
            reportId: null,
            limits: this.getLimits(options.limits),
            createdAt: timestamp,
            updatedAt: timestamp,
            completedAt: null,
            error: null
        };

        this.activeRunId = run.id;
        await putRecord('deepResearchRuns', run);
        this._emit(run, 'created');

        try {
            await this._recordStep(run, 'planning', 'running', 'Building subquestions and search plan.');
            run.plan = this._buildPlan(cleanedQuery, run.limits.maxSearches);
            await this._recordStep(run, 'planning', 'completed', `Prepared ${run.plan.length} focused searches.`);

            await this._recordStep(run, 'searching', 'running', 'Running multiple web searches.');
            const results = await this._runSearches(run);
            await this._recordStep(run, 'searching', 'completed', `Collected ${results.length} unique candidate sources.`);

            await this._recordStep(run, 'reading', 'running', 'Fetching and extracting source text.');
            const sources = await this._fetchAndStoreSources(run, results);
            await this._recordStep(run, 'reading', 'completed', `Stored ${sources.length} readable sources.`);

            await this._recordStep(run, 'synthesizing', 'running', 'Synthesizing cited report.');
            const sourceRecords = await this.getSources(run.id);
            const synthesis = this._synthesizeReport(run, sourceRecords);
            run.notes = synthesis.notes;
            run.findings = synthesis.findings;
            run.report = synthesis.report;
            run.status = 'completed';
            run.completedAt = now();
            run.updatedAt = run.completedAt;
            await putRecord('deepResearchRuns', run);

            const savedReport = await researchReportService.saveFromDeepResearchRun({
                id: run.id,
                runId: run.id,
                title: run.title,
                query: run.query,
                topic: run.query,
                projectId: run.projectId,
                tags: ['deep-research'],
                status: 'completed',
                sources: sourceRecords.map(source => ({
                    id: source.id,
                    title: source.title,
                    url: source.url,
                    type: 'web',
                    notes: source.snippet || source.excerpt || '',
                    confidence: source.confidence
                })),
                extractedNotes: run.notes,
                intermediateFindings: run.findings,
                body: run.report,
                finalSynthesis: synthesis.summary,
                citations: sourceRecords.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`),
                completedAt: run.completedAt,
                createdAt: run.createdAt
            });
            run.reportId = savedReport.id;
            await this._recordStep(run, 'synthesizing', 'completed', `Saved report ${savedReport.id}.`);
            run.updatedAt = now();
            await putRecord('deepResearchRuns', run);
            this._emit(run, 'completed');
            return run;
        } catch (err) {
            run.status = 'failed';
            run.error = err.message || String(err);
            run.updatedAt = now();
            await this._recordStep(run, 'failed', 'failed', run.error);
            await putRecord('deepResearchRuns', run);
            this._emit(run, 'failed');
            throw err;
        } finally {
            if (this.activeRunId === run.id) this.activeRunId = null;
        }
    }

    _buildPlan(query, maxSearches) {
        const base = query.replace(/[?.!]+$/g, '');
        const templates = [
            base,
            `${base} evidence analysis`,
            `${base} recent developments`,
            `${base} risks limitations`,
            `${base} comparison best practices`,
            `${base} statistics data`
        ];
        const unique = [...new Set(templates.map(normalizeText).filter(Boolean))];
        return unique.slice(0, Math.max(1, maxSearches)).map((searchQuery, index) => ({
            id: id('question'),
            order: index + 1,
            subquestion: index === 0 ? `What is the current answer to: ${query}?` : `What does evidence say about ${searchQuery}?`,
            searchQuery,
            status: 'pending'
        }));
    }

    async _runSearches(run) {
        const all = [];
        const seen = new Set();
        for (const item of run.plan) {
            item.status = 'running';
            await this._saveRun(run);
            try {
                const results = await this._search(item.searchQuery, run.limits.maxResultsPerSearch);
                item.status = 'completed';
                run.searches.push({ query: item.searchQuery, count: results.length, completedAt: now() });
                for (const result of results) {
                    const key = normalizeUrl(result.url) || normalizeText(result.title).toLowerCase();
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    all.push({ ...result, searchQuery: item.searchQuery, rank: all.length + 1 });
                    if (all.length >= run.limits.maxSources) break;
                }
            } catch (err) {
                item.status = 'failed';
                item.error = err.message || String(err);
                run.searches.push({ query: item.searchQuery, count: 0, error: item.error, completedAt: now() });
            }
            await this._saveRun(run);
            if (all.length >= run.limits.maxSources) break;
        }
        if (!all.length) throw new Error('No web search results were collected. Check Settings → Web Search provider/API key or local SearXNG.');
        return all;
    }

    async _search(query, maxResults) {
        const settings = storageService.loadSettings?.() || {};
        const provider = settings.searchProvider || 'searxng';
        if (provider === 'tavily') return this._searchTavily(query, settings.tavilyApiKey, maxResults);
        if (provider === 'brave') return this._searchBrave(query, settings.braveApiKey, maxResults);
        return this._searchSearXNG(query, settings.searxngUrl || 'http://localhost:8888', maxResults);
    }

    async _searchSearXNG(query, baseUrl, maxResults) {
        const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`);
        if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
        const data = await response.json();
        return (data.results || []).slice(0, maxResults).map(result => ({
            title: result.title || result.url,
            url: result.url,
            snippet: result.content || ''
        }));
    }

    async _searchBrave(query, apiKey, maxResults) {
        if (!apiKey) throw new Error('Brave API key not configured.');
        const response = await fetch(`/api/brave/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
            headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}`);
        const data = await response.json();
        return (data.web?.results || []).slice(0, maxResults).map(result => ({
            title: result.title || result.url,
            url: result.url,
            snippet: result.description || ''
        }));
    }

    async _searchTavily(query, apiKey, maxResults) {
        if (!apiKey) throw new Error('Tavily API key not configured.');
        const response = await fetch('/api/tavily/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: 'advanced', include_answer: false })
        });
        if (!response.ok) throw new Error(`Tavily Search returned HTTP ${response.status}`);
        const data = await response.json();
        return (data.results || []).slice(0, maxResults).map(result => ({
            title: result.title || result.url,
            url: result.url,
            snippet: result.content || result.snippet || ''
        }));
    }

    async _fetchAndStoreSources(run, results) {
        const sources = [];
        for (const result of results.slice(0, run.limits.maxSources)) {
            const source = {
                id: id('dsrc'),
                runId: run.id,
                rank: sources.length + 1,
                title: result.title || result.url || 'Untitled source',
                url: result.url || '',
                normalizedUrl: normalizeUrl(result.url),
                snippet: result.snippet || '',
                searchQuery: result.searchQuery,
                status: 'pending',
                content: '',
                excerpt: '',
                wordCount: 0,
                confidence: 0.55,
                createdAt: now(),
                updatedAt: now()
            };
            try {
                source.status = 'fetching';
                await putRecord('deepResearchSources', source);
                const content = await this._fetchReadableText(source.url, run.limits.fetchTimeoutMs);
                source.content = content.slice(0, run.limits.maxCharsPerSource);
                source.excerpt = this._bestExcerpt(source.content || source.snippet, run.query);
                source.wordCount = source.content.split(/\s+/).filter(Boolean).length;
                source.confidence = source.wordCount > 250 ? 0.75 : 0.6;
                source.status = 'ready';
            } catch (err) {
                source.status = 'snippet-only';
                source.error = err.message || String(err);
                source.content = source.snippet;
                source.excerpt = source.snippet;
                source.wordCount = source.content.split(/\s+/).filter(Boolean).length;
                source.confidence = 0.45;
            }
            source.updatedAt = now();
            await putRecord('deepResearchSources', source);
            run.sourceIds.push(source.id);
            await this._saveRun(run);
            sources.push(source);
        }
        return sources;
    }

    async _fetchReadableText(url, timeoutMs) {
        if (!url) throw new Error('No URL to fetch');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { signal: controller.signal, mode: 'cors' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentType = response.headers.get('content-type') || '';
            const raw = await response.text();
            if (contentType.includes('html') || /<html|<body|<article/i.test(raw)) return this._extractHtml(raw);
            return normalizeText(raw);
        } finally {
            clearTimeout(timer);
        }
    }

    _extractHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form').forEach(node => node.remove());
        const title = doc.querySelector('title')?.textContent || '';
        const main = doc.querySelector('article, main, [role="main"]') || doc.body;
        return normalizeText(`${title}\n\n${main?.textContent || ''}`);
    }

    _bestExcerpt(text, query) {
        const terms = normalizeText(query).toLowerCase().split(/\W+/).filter(term => term.length > 3);
        const sentences = normalizeText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
        const ranked = sentences.map(sentence => {
            const lower = sentence.toLowerCase();
            const termHits = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
            return { sentence, score: termHits * 2 + sentenceScore(sentence) };
        }).sort((a, b) => b.score - a.score);
        return ranked.slice(0, 4).map(item => item.sentence).join(' ').slice(0, 1200) || normalizeText(text).slice(0, 1200);
    }

    _synthesizeReport(run, sources) {
        const usable = sources.filter(source => source.excerpt || source.snippet);
        const notes = usable.map((source, index) => ({
            sourceId: source.id,
            text: `[${index + 1}] ${source.title}: ${source.excerpt || source.snippet}`
        }));
        const findings = usable.slice(0, 6).map((source, index) => `${index + 1}. ${source.title} suggests: ${(source.excerpt || source.snippet || '').slice(0, 240)}`);
        const sourceList = usable.map((source, index) => `${index + 1}. ${source.title} — ${source.url}`).join('\n');
        const summary = usable.length
            ? `Reviewed ${usable.length} web sources for “${run.query}”. The strongest evidence is summarized below; verify critical claims before acting because synthesis is deterministic and source quality varies.`
            : `No readable sources were available for “${run.query}”.`;
        const evidence = usable.map((source, index) => `- [${index + 1}] **${source.title}**: ${source.excerpt || source.snippet || 'No excerpt available.'}`).join('\n');
        const gaps = run.searches.filter(search => search.error).map(search => `- Search failed for “${search.query}”: ${search.error}`).join('\n') || '- No failed searches recorded. CORS may still limit full-text extraction for some web pages.';
        const report = `# ${run.title}\n\n## Query\n${run.query}\n\n## Executive Summary\n${summary}\n\n## Research Plan\n${run.plan.map(item => `- ${item.subquestion} (${item.searchQuery})`).join('\n')}\n\n## Evidence Notes\n${evidence || 'No evidence notes recorded.'}\n\n## Uncertainty and Gaps\n${gaps}\n\n## Sources\n${sourceList || 'No sources recorded.'}\n`;
        return { notes, findings, summary, report };
    }

    async _recordStep(run, name, status, message) {
        const existing = run.steps.find(step => step.name === name && step.status !== 'completed');
        const step = existing || { id: id('step'), name, startedAt: now() };
        step.status = status;
        step.message = message;
        step.updatedAt = now();
        if (status === 'completed' || status === 'failed') step.completedAt = now();
        if (!existing) run.steps.push(step);
        await this._saveRun(run);
    }

    async _saveRun(run) {
        run.updatedAt = now();
        await putRecord('deepResearchRuns', run);
        this._emit(run, 'updated');
    }

    _emit(run, action) {
        eventBus.emit(Events.DEEP_RESEARCH_UPDATED, { runId: run.id, action, run });
    }
}

export const deepResearchService = new DeepResearchService();
export { DEFAULT_LIMITS };

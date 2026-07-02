import { putRecord, getRecord, getAllRecords, getRecordsByIndex, deleteRecord } from './idbStore.js';
import { researchReportService } from './researchReportService.js';
import { storageService } from './storageService.js';
import { eventBus, Events } from '../utils/eventBus.js';

const DEFAULT_LIMITS = {
    maxSearches: 4,
    maxResultsPerSearch: 5,
    maxSources: 8,
    maxLocalSources: 4,
    maxCharsPerSource: 9000,
    fetchTimeoutMs: 9000,
    enableSecondPass: true,
    includeLocalDocuments: false,
    localCollectionId: 'document-library',
    reportFormat: 'technical'
};

const REPORT_FORMATS = ['summary', 'technical', 'comparison', 'recommendation'];

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
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach(key => url.searchParams.delete(key));
        if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
        return url.toString().toLowerCase();
    } catch {
        return String(value || '').trim().toLowerCase();
    }
}

function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value = '') {
    return normalizeText(value).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\b(the|a|an|and|or|of|for|to|in|on|with|by)\b/g, '').replace(/\s+/g, ' ').trim();
}

function keywordSet(value = '') {
    return new Set(normalizeText(value).toLowerCase().split(/\W+/).filter(term => term.length > 4));
}

function jaccardSimilarity(a, b) {
    const left = keywordSet(a);
    const right = keywordSet(b);
    if (!left.size || !right.size) return 0;
    let overlap = 0;
    left.forEach(term => {
        if (right.has(term)) overlap += 1;
    });
    return overlap / Math.max(1, new Set([...left, ...right]).size);
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
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
    const signals = ['because', 'evidence', 'study', 'report', 'analysis', 'shows', 'according', 'data', 'estimate', 'risk', 'benefit', 'conflict', 'uncertain'];
    return signals.reduce((score, signal) => score + (value.includes(signal) ? 1 : 0), 0) + Math.min(4, text.length / 220);
}

class DeepResearchService {
    constructor() {
        this.activeRunId = null;
    }

    async init() {
        return true;
    }

    getLimits(overrides = {}) {
        const settings = storageService.loadSettings?.() || {};
        const merged = {
            ...DEFAULT_LIMITS,
            ...settings.deepResearchLimits,
            ...overrides
        };
        return {
            ...merged,
            maxSearches: clampNumber(merged.maxSearches, 1, 8, DEFAULT_LIMITS.maxSearches),
            maxResultsPerSearch: clampNumber(merged.maxResultsPerSearch, 1, 10, DEFAULT_LIMITS.maxResultsPerSearch),
            maxSources: clampNumber(merged.maxSources, 1, 20, DEFAULT_LIMITS.maxSources),
            maxLocalSources: clampNumber(merged.maxLocalSources, 1, 12, DEFAULT_LIMITS.maxLocalSources),
            maxCharsPerSource: clampNumber(merged.maxCharsPerSource, 1200, 30000, DEFAULT_LIMITS.maxCharsPerSource),
            fetchTimeoutMs: clampNumber(merged.fetchTimeoutMs, 2500, 30000, DEFAULT_LIMITS.fetchTimeoutMs),
            enableSecondPass: merged.enableSecondPass !== false,
            includeLocalDocuments: merged.includeLocalDocuments === true,
            localCollectionId: normalizeText(merged.localCollectionId || DEFAULT_LIMITS.localCollectionId) || DEFAULT_LIMITS.localCollectionId,
            reportFormat: REPORT_FORMATS.includes(merged.reportFormat) ? merged.reportFormat : DEFAULT_LIMITS.reportFormat
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

    async exportRun(runId, format = 'markdown') {
        const run = await this.getRun(runId);
        if (!run) throw new Error('Deep Research run not found.');
        const sources = await this.getSources(runId);
        if (format === 'json') return JSON.stringify({ ...run, sources }, null, 2);
        const sourceAppendix = sources.map((source, index) => `- [${index + 1}] ${source.title} — ${source.url || 'No URL'} (${source.status}, confidence ${Math.round((source.confidence || 0) * 100)}%)`).join('\n');
        return `${run.report || `# ${run.title || run.query}`}\n\n---\nExported from Synapse Deep Research on ${now()}\n\n## Source Appendix\n${sourceAppendix || 'No sources recorded.'}\n`;
    }

    async startRun(query, options = {}) {
        const cleanedQuery = normalizeText(query);
        if (!cleanedQuery) throw new Error('Enter a research question first.');
        const limits = this.getLimits(options.limits);

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
            gapAnalysis: null,
            reportFormat: limits.reportFormat,
            report: '',
            reportId: null,
            limits,
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
            await this._recordStep(run, 'searching', 'completed', `Collected ${results.length} unique candidate sources after URL/title/snippet deduplication.`);

            await this._recordStep(run, 'reading', 'running', 'Fetching and extracting source text.');
            const webBudget = run.limits.includeLocalDocuments
                ? Math.max(1, run.limits.maxSources - run.limits.maxLocalSources)
                : run.limits.maxSources;
            const sources = await this._fetchAndStoreSources(run, results.slice(0, webBudget));
            await this._recordStep(run, 'reading', 'completed', `Stored ${sources.length} readable sources.`);

            if (run.limits.includeLocalDocuments) {
                await this._recordStep(run, 'local-documents', 'running', 'Searching uploaded-file RAG/document sources.');
                const localSources = await this._collectLocalDocumentSources(run);
                await this._recordStep(run, 'local-documents', 'completed', `Added ${localSources.length} local document source(s) from ${run.limits.localCollectionId}.`);
            }

            if (run.limits.enableSecondPass) {
                await this._recordStep(run, 'gap-analysis', 'running', 'Checking coverage, conflicts, weak evidence, and follow-up needs.');
                run.gapAnalysis = this._analyzeGaps(run, await this.getSources(run.id));
                await this._recordStep(run, 'gap-analysis', 'completed', this._gapSummary(run.gapAnalysis));
                if (run.gapAnalysis.followUpQueries.length && run.sourceIds.length < run.limits.maxSources) {
                    await this._recordStep(run, 'second-pass-search', 'running', 'Running follow-up searches for weak or missing evidence.');
                    const followUpResults = await this._runFollowUpSearches(run, run.gapAnalysis.followUpQueries);
                    if (followUpResults.length) await this._fetchAndStoreSources(run, followUpResults);
                    run.gapAnalysis = this._analyzeGaps(run, await this.getSources(run.id));
                    await this._recordStep(run, 'second-pass-search', 'completed', `Added ${followUpResults.length} follow-up candidate sources.`);
                }
            }

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
                tags: ['deep-research', run.reportFormat],
                status: 'completed',
                sources: sourceRecords.map(source => ({
                    id: source.id,
                    title: source.title,
                    url: source.url,
                    type: source.sourceType || 'web',
                    documentId: source.documentId || null,
                    notes: source.snippet || source.excerpt || '',
                    confidence: source.confidence
                })),
                extractedNotes: run.notes,
                intermediateFindings: run.findings,
                body: run.report,
                finalSynthesis: synthesis.summary,
                citations: sourceRecords.map((source, index) => this._citationLine(source, index)),
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
        const seen = [];
        for (const item of run.plan) {
            item.status = 'running';
            await this._saveRun(run);
            try {
                const results = await this._search(item.searchQuery, run.limits.maxResultsPerSearch);
                item.status = 'completed';
                run.searches.push({ query: item.searchQuery, count: results.length, completedAt: now() });
                for (const result of results) {
                    if (this._isDuplicateCandidate(result, seen)) continue;
                    seen.push(result);
                    all.push({ ...result, searchQuery: item.searchQuery, rank: all.length + 1, duplicateSignals: [] });
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
        if (!all.length && !run.limits.includeLocalDocuments) throw new Error('No web search results were collected. Check Settings → Web Search provider/API key or local SearXNG.');
        return all;
    }

    async _runFollowUpSearches(run, queries) {
        const existing = await this.getSources(run.id);
        const seen = existing.map(source => ({ title: source.title, url: source.url, snippet: source.snippet || source.excerpt || source.content }));
        const candidates = [];
        for (const query of queries.slice(0, 2)) {
            try {
                const results = await this._search(query, Math.min(3, run.limits.maxResultsPerSearch));
                run.searches.push({ query, count: results.length, secondPass: true, completedAt: now() });
                for (const result of results) {
                    if (this._isDuplicateCandidate(result, [...seen, ...candidates])) continue;
                    candidates.push({ ...result, searchQuery: query, secondPass: true, rank: existing.length + candidates.length + 1 });
                    if (run.sourceIds.length + candidates.length >= run.limits.maxSources) break;
                }
            } catch (err) {
                run.searches.push({ query, count: 0, secondPass: true, error: err.message || String(err), completedAt: now() });
            }
            await this._saveRun(run);
            if (run.sourceIds.length + candidates.length >= run.limits.maxSources) break;
        }
        return candidates;
    }

    _isDuplicateCandidate(candidate, existing) {
        const url = normalizeUrl(candidate.url);
        const title = normalizeTitle(candidate.title);
        const snippet = candidate.snippet || candidate.content || '';
        return existing.some(item => {
            const itemUrl = normalizeUrl(item.url);
            if (url && itemUrl && url === itemUrl) return true;
            if (title && normalizeTitle(item.title) === title) return true;
            const titleSimilarity = jaccardSimilarity(candidate.title, item.title);
            const contentSimilarity = jaccardSimilarity(snippet, item.snippet || item.content || item.excerpt || '');
            return titleSimilarity >= 0.82 || contentSimilarity >= 0.72;
        });
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
        const existing = await this.getSources(run.id);
        const seen = [...existing.map(source => ({ title: source.title, url: source.url, content: source.content || source.excerpt || source.snippet }))];
        for (const result of results.slice(0, run.limits.maxSources)) {
            if (run.sourceIds.length >= run.limits.maxSources) break;
            if (this._isDuplicateCandidate(result, seen)) continue;
            const source = {
                id: id('dsrc'),
                runId: run.id,
                rank: run.sourceIds.length + 1,
                title: result.title || result.url || 'Untitled source',
                url: result.url || '',
                normalizedUrl: normalizeUrl(result.url),
                normalizedTitle: normalizeTitle(result.title),
                sourceType: result.sourceType || 'web',
                documentId: result.documentId || null,
                collectionId: result.collectionId || null,
                chunkId: result.chunkId || null,
                snippet: result.snippet || '',
                searchQuery: result.searchQuery,
                secondPass: Boolean(result.secondPass),
                status: 'pending',
                content: '',
                excerpt: '',
                wordCount: 0,
                confidence: result.confidence || 0.55,
                createdAt: now(),
                updatedAt: now()
            };
            try {
                source.status = 'fetching';
                await putRecord('deepResearchSources', source);
                const content = source.sourceType === 'local-document'
                    ? normalizeText(result.content || result.snippet || '')
                    : await this._fetchReadableText(source.url, run.limits.fetchTimeoutMs);
                source.content = content.slice(0, run.limits.maxCharsPerSource);
                source.excerpt = this._bestExcerpt(source.content || source.snippet, run.query);
                source.wordCount = source.content.split(/\s+/).filter(Boolean).length;
                source.confidence = source.wordCount > 450 ? 0.78 : source.wordCount > 160 ? 0.68 : 0.58;
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
            seen.push({ title: source.title, url: source.url, content: source.content || source.excerpt || source.snippet });
            await this._saveRun(run);
            sources.push(source);
        }
        return sources;
    }

    async _collectLocalDocumentSources(run) {
        const candidates = await this._searchLocalDocuments(run.query, run.limits.localCollectionId, run.limits.maxLocalSources);
        if (!candidates.length) return [];
        return this._fetchAndStoreSources(run, candidates.map((candidate, index) => ({
            ...candidate,
            rank: run.sourceIds.length + index + 1,
            sourceType: 'local-document',
            searchQuery: `local:${run.limits.localCollectionId}`
        })));
    }

    async _searchLocalDocuments(query, collectionId, maxLocalSources) {
        const docs = await getAllRecords('ragDocuments');
        const chunks = await getAllRecords('ragChunks');
        const scopedDocs = docs.filter(doc => !collectionId || doc.collectionId === collectionId || doc.chatId === collectionId || collectionId === 'all');
        const byDocument = new Map();
        for (const doc of scopedDocs) {
            const text = normalizeText(doc.content || doc.text || doc.summary || '');
            if (text) {
                byDocument.set(doc.id, {
                    id: doc.id,
                    title: doc.title || doc.name || doc.id,
                    collectionId: doc.collectionId || doc.chatId || collectionId,
                    content: text,
                    metadata: doc.metadata || {}
                });
            }
        }
        for (const chunk of chunks) {
            const doc = scopedDocs.find(item => item.id === chunk.documentId);
            if (!doc) continue;
            const existing = byDocument.get(doc.id) || {
                id: doc.id,
                title: doc.title || doc.name || doc.id,
                collectionId: doc.collectionId || doc.chatId || collectionId,
                content: '',
                metadata: doc.metadata || {}
            };
            existing.content = normalizeText(`${existing.content}\n\n${chunk.text || ''}`);
            byDocument.set(doc.id, existing);
        }
        const scored = [...byDocument.values()]
            .map(doc => ({ ...doc, score: jaccardSimilarity(query, `${doc.title} ${doc.content}`) }))
            .filter(doc => doc.content && doc.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxLocalSources);
        return scored.map(doc => ({
            title: doc.title,
            url: `synapse://rag/${encodeURIComponent(doc.id)}`,
            snippet: this._bestExcerpt(doc.content, query),
            content: doc.content,
            documentId: doc.id,
            collectionId: doc.collectionId,
            confidence: Math.min(0.9, Math.max(0.58, doc.score + 0.45))
        }));
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

    _analyzeGaps(run, sources) {
        const usable = sources.filter(source => source.excerpt || source.snippet || source.content);
        const failedSearches = run.searches.filter(search => search.error);
        const snippetOnly = usable.filter(source => source.status === 'snippet-only');
        const lowConfidence = usable.filter(source => (source.confidence || 0) < 0.6);
        const conflictSignals = usable.filter(source => /\b(conflict|controvers|debate|uncertain|mixed evidence|inconsistent|risk|limitation)\b/i.test(`${source.excerpt} ${source.snippet}`));
        const queryTerms = [...keywordSet(run.query)];
        const uncoveredTerms = queryTerms.filter(term => !usable.some(source => `${source.title} ${source.excerpt} ${source.snippet}`.toLowerCase().includes(term)));
        const followUpQueries = [];
        if (usable.length < Math.min(4, run.limits.maxSources)) followUpQueries.push(`${run.query} independent sources evidence`);
        if (snippetOnly.length > Math.max(1, usable.length / 2)) followUpQueries.push(`${run.query} detailed report analysis`);
        if (conflictSignals.length) followUpQueries.push(`${run.query} conflicting evidence limitations`);
        if (uncoveredTerms.length) followUpQueries.push(`${run.query} ${uncoveredTerms.slice(0, 3).join(' ')} evidence`);
        return {
            usableSources: usable.length,
            failedSearches: failedSearches.length,
            snippetOnlySources: snippetOnly.length,
            lowConfidenceSources: lowConfidence.length,
            conflictSignals: conflictSignals.map(source => ({ sourceId: source.id, title: source.title })),
            uncoveredTerms,
            followUpQueries: [...new Set(followUpQueries.map(normalizeText).filter(Boolean))].slice(0, 3),
            updatedAt: now()
        };
    }

    _gapSummary(gapAnalysis) {
        if (!gapAnalysis) return 'No gap analysis recorded.';
        const parts = [`${gapAnalysis.usableSources} usable sources`];
        if (gapAnalysis.snippetOnlySources) parts.push(`${gapAnalysis.snippetOnlySources} snippet-only`);
        if (gapAnalysis.conflictSignals.length) parts.push(`${gapAnalysis.conflictSignals.length} conflict/uncertainty signals`);
        if (gapAnalysis.followUpQueries.length) parts.push(`${gapAnalysis.followUpQueries.length} follow-up queries queued`);
        return parts.join('; ');
    }

    _synthesizeReport(run, sources) {
        const usable = sources.filter(source => source.excerpt || source.snippet);
        const localCount = usable.filter(source => source.sourceType === 'local-document').length;
        const webCount = usable.length - localCount;
        const notes = usable.map((source, index) => ({
            sourceId: source.id,
            type: source.sourceType || 'web',
            text: `[${index + 1}] ${source.title}: ${source.excerpt || source.snippet}`
        }));
        const findings = usable.slice(0, 8).map((source, index) => `${index + 1}. ${source.title} suggests: ${(source.excerpt || source.snippet || '').slice(0, 280)}`);
        const sourceList = usable.map((source, index) => this._citationLine(source, index)).join('\n');
        const summary = usable.length
            ? `Reviewed ${usable.length} sources (${webCount} web, ${localCount} local document) for “${run.query}” with ${run.reportFormat} formatting. Source quality is mixed; verify critical claims before acting because synthesis is deterministic and browser fetches can be CORS-limited.`
            : `No readable sources were available for “${run.query}”.`;
        const evidence = usable.map((source, index) => `- [${index + 1}] **${source.title}** (${source.sourceType === 'local-document' ? 'local document' : 'web'}, ${Math.round((source.confidence || 0) * 100)}% confidence): ${source.excerpt || source.snippet || 'No excerpt available.'}`).join('\n');
        const uncertainty = this._formatUncertainty(run, usable);
        const formatSection = this._formatReportBody(run, usable, evidence);
        const gaps = run.searches.filter(search => search.error).map(search => `- Search failed for “${search.query}”: ${search.error}`).join('\n') || '- No failed searches recorded. CORS may still limit full-text extraction for some web pages.';
        const report = `# ${run.title}\n\n## Query\n${run.query}\n\n## Executive Summary\n${summary}\n\n## Source Mix\n- Web sources: ${webCount}\n- Uploaded/local document sources: ${localCount}\n- Local source pool: ${run.limits.includeLocalDocuments ? run.limits.localCollectionId : 'disabled'}\n\n## Research Plan\n${run.plan.map(item => `- ${item.subquestion} (${item.searchQuery})`).join('\n')}\n\n${formatSection}\n\n## Evidence Notes\n${evidence || 'No evidence notes recorded.'}\n\n## Uncertainty, Conflicts, and Gaps\n${uncertainty}\n\n${gaps}\n\n## Sources\n${sourceList || 'No sources recorded.'}\n`;
        return { notes, findings, summary, report };
    }

    _citationLine(source, index) {
        const number = index + 1;
        if (source.sourceType === 'local-document') {
            return `[${number}] ${source.title} — local document (${source.collectionId || 'document-library'}${source.documentId ? ` / ${source.documentId}` : ''})`;
        }
        return `[${number}] ${source.title} — ${source.url || 'No URL'}`;
    }

    _formatReportBody(run, sources, evidence) {
        if (run.reportFormat === 'summary') {
            return `## Concise Answer\n${sources.slice(0, 4).map((source, index) => `- [${index + 1}] ${source.excerpt || source.snippet || source.title}`).join('\n') || 'No concise answer available.'}`;
        }
        if (run.reportFormat === 'comparison') {
            return `## Comparison Matrix\n| Angle | Supporting sources | Notes |\n| --- | --- | --- |\n| Evidence strength | ${sources.length} sources | Stronger when multiple fetched pages agree. |\n| Risks / limitations | ${(run.gapAnalysis?.conflictSignals || []).length} signals | Treat controversy and snippet-only pages as weaker evidence. |\n| Coverage gaps | ${(run.gapAnalysis?.uncoveredTerms || []).join(', ') || 'None detected'} | Second pass runs when budget allows. |`;
        }
        if (run.reportFormat === 'recommendation') {
            return `## Recommendation-Oriented Synthesis\n- Best supported direction: use the cited evidence below as the starting point, prioritizing higher-confidence fetched sources.\n- Decision cautions: ${this._gapSummary(run.gapAnalysis)}.\n- Next check: verify any critical claim from at least two sources before acting.\n\n## Supporting Evidence\n${evidence || 'No evidence notes recorded.'}`;
        }
        return `## Technical Synthesis\n- Sources analyzed: ${sources.length}\n- Deduplication: URL, normalized title, and content-similarity filters were applied before reading sources.\n- Budget: up to ${run.limits.maxSearches} web searches, ${run.limits.maxSources} total sources, ${run.limits.maxLocalSources} local document sources, ${run.limits.maxCharsPerSource} chars/source, ${run.limits.fetchTimeoutMs}ms fetch timeout.\n- Local documents: ${run.limits.includeLocalDocuments ? `enabled from ${run.limits.localCollectionId}` : 'disabled'}.\n- Gap analysis: ${this._gapSummary(run.gapAnalysis)}.`;
    }

    _formatUncertainty(run, sources) {
        const gap = run.gapAnalysis;
        const lines = [];
        if (!sources.length) lines.push('- Evidence is weak: no readable sources were stored.');
        if (gap?.snippetOnlySources) lines.push(`- ${gap.snippetOnlySources} source(s) are snippet-only because full-text fetch failed or was blocked.`);
        if (gap?.lowConfidenceSources) lines.push(`- ${gap.lowConfidenceSources} source(s) have low confidence due to short extracted text.`);
        if (gap?.conflictSignals?.length) lines.push(`- Conflict/uncertainty language appeared in: ${gap.conflictSignals.map(item => item.title).join('; ')}.`);
        if (gap?.uncoveredTerms?.length) lines.push(`- Query terms with weak coverage: ${gap.uncoveredTerms.slice(0, 8).join(', ')}.`);
        if (!lines.length) lines.push('- No major automated uncertainty signals were detected; still verify important claims manually.');
        return lines.join('\n');
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
export { DEFAULT_LIMITS, REPORT_FORMATS };

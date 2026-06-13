/**
 * MemoryService — Persistent semantic memory with vector + keyword retrieval.
 *
 * Memory layers:
 *   - fact:        Key facts, entities, terminology
 *   - preference:  User preferences, style choices, defaults
 *   - procedure:   How-to steps, workflows, recipes
 *   - context:     Project background, architecture decisions, constraints
 *
 * Each entry carries source metadata: provenance (who added it, from what
 * source), recency (timestamps), confidence (0–1), and project scope.
 *
 * Retrieval policies differ by session mode:
 *   - chat:      facts + preferences, top 5, threshold 0.35
 *   - research:  all layers, top 10, threshold 0.25
 *   - compare:   facts + context, top 8, threshold 0.3
 *   - document:  facts + context + procedures, top 8, threshold 0.3
 *   - agent:     all layers, top 15, threshold 0.2
 *
 * Storage: IndexedDB (memoryEntries + memoryEmbeddings stores).
 * Embeddings: reuses EmbeddingsService (same model as RAG).
 */

import {
    putRecord, putRecords, getRecord, getAllRecords,
    getRecordsByIndex, deleteRecord, deleteByIndex,
    clearStore, countRecords
} from './idbStore.js';
import { embeddingsService } from './embeddingsService.js';
import { storageService } from './storageService.js';
import { eventBus, Events } from '../utils/eventBus.js';

// ── Constants ──────────────────────────────────────────────────────────────

const LAYERS = ['fact', 'preference', 'procedure', 'context'];
const VALID_LAYERS = new Set(LAYERS);

/** Retrieval policies per session mode */
const MODE_POLICIES = {
    chat:     { layers: ['fact', 'preference'],                 topK: 5,  threshold: 0.35, boostRecent: true  },
    research: { layers: LAYERS,                                  topK: 10, threshold: 0.25, boostRecent: true  },
    compare:  { layers: ['fact', 'context'],                     topK: 8,  threshold: 0.30, boostRecent: false },
    document: { layers: ['fact', 'context', 'procedure'],        topK: 8,  threshold: 0.30, boostRecent: false },
    agent:    { layers: LAYERS,                                  topK: 15, threshold: 0.20, boostRecent: true  }
};

const DEFAULT_PROJECT = '__global__';

// ── Helpers ────────────────────────────────────────────────────────────────

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Simple BM25-style keyword scoring.
 * Tokenises text into lowercased words, computes term overlap ratio.
 */
function keywordScore(queryTokens, entryTokens) {
    if (queryTokens.length === 0 || entryTokens.length === 0) return 0;
    let matches = 0;
    for (const t of queryTokens) {
        if (entryTokens.has(t)) matches++;
    }
    return matches / queryTokens.length;
}

function tokenize(text) {
    return (text || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

/**
 * Recency boost: exponentially decays from 1 (just now) toward 0.5 (old).
 * Half-life ≈ 30 days.
 */
function recencyBoost(createdAt, updatedAt) {
    const ts = updatedAt || createdAt;
    if (!ts) return 0.75;
    const ageMs = Date.now() - new Date(ts).getTime();
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000;
    return 0.5 + 0.5 * Math.pow(0.5, ageMs / halfLifeMs);
}

// ── Service ────────────────────────────────────────────────────────────────

class MemoryService {
    constructor() {
        this._ready = false;
        /** @type {Map<string, { vector: Float32Array, tokens: Set<string> }>} entryId → cached data */
        this._cache = new Map();
        this._cacheLoaded = false;
        this._embeddingJob = null; // AbortController for any in-flight embedding
    }

    // ── Initialisation ────────────────────────────────────────────────────

    async init() {
        if (this._ready) return;
        // Ensure IDB stores exist (opened by storageService.init() earlier)
        this._ready = true;
    }

    /**
     * Load all entry + embedding data into memory for fast retrieval.
     * Called once after init, lazily on first search.
     */
    async _ensureCache() {
        if (this._cacheLoaded) return;
        const entries = await getAllRecords('memoryEntries');
        const embeddings = await getAllRecords('memoryEmbeddings');

        const embMap = new Map();
        for (const e of embeddings) {
            embMap.set(e.entryId, e);
        }

        for (const entry of entries) {
            const emb = embMap.get(entry.id);
            this._cache.set(entry.id, {
                entry,
                vector: emb ? new Float32Array(emb.vector) : null,
                tokens: new Set(tokenize(`${entry.content} ${entry.tags?.join(' ') || ''}`))
            });
        }
        this._cacheLoaded = true;
    }

    /** Invalidate cache (call after writes/deletes) */
    _invalidateCache() {
        this._cache.clear();
        this._cacheLoaded = false;
    }

    // ── CRUD ──────────────────────────────────────────────────────────────

    /**
     * Store a new memory entry.
     * @param {Object} params
     * @param {string} params.content       - The memory text
     * @param {string} params.layer         - fact|preference|procedure|context
     * @param {string} [params.projectId]   - Project scope (default: __global__)
     * @param {number} [params.confidence]  - 0–1 (default: 0.8)
     * @param {Object} [params.source]      - { type: 'user'|'auto'|'import'|'correction', chatId?, label? }
     * @param {string[]} [params.tags]      - Free-form tags
     * @returns {Promise<Object>} The stored entry
     */
    async store({ content, layer, projectId, confidence, source, tags }) {
        if (!content || !content.trim()) throw new Error('Content is required');
        const normLayer = (layer || 'fact').toLowerCase();
        if (!VALID_LAYERS.has(normLayer)) throw new Error(`Invalid layer: ${layer}`);

        const now = new Date().toISOString();
        const entry = {
            id: generateId(),
            content: content.trim(),
            layer: normLayer,
            projectId: projectId || DEFAULT_PROJECT,
            confidence: Math.max(0, Math.min(1, confidence ?? 0.8)),
            source: {
                type: source?.type || 'user',
                chatId: source?.chatId || null,
                label: source?.label || null
            },
            tags: Array.isArray(tags) ? tags : [],
            accessCount: 0,
            lastAccessedAt: null,
            createdAt: now,
            updatedAt: now,
            embeddingStatus: 'pending'
        };

        await putRecord('memoryEntries', entry);
        this._invalidateCache();
        eventBus.emit(Events.MEMORY_STORED, { entry });

        // Auto-embed in background
        this._embedEntry(entry).catch(err => {
            console.warn('[Memory] Embedding failed for', entry.id, err);
        });

        return entry;
    }

    /**
     * Update an existing memory entry.
     * @param {string} entryId
     * @param {Object} updates - Partial update (content, layer, confidence, tags, source)
     * @returns {Promise<Object>} Updated entry
     */
    async update(entryId, updates) {
        const entry = await getRecord('memoryEntries', entryId);
        if (!entry) throw new Error(`Memory entry not found: ${entryId}`);

        if (updates.content !== undefined) entry.content = updates.content.trim();
        if (updates.layer !== undefined) {
            if (!VALID_LAYERS.has(updates.layer)) throw new Error(`Invalid layer: ${updates.layer}`);
            entry.layer = updates.layer;
        }
        if (updates.confidence !== undefined) entry.confidence = Math.max(0, Math.min(1, updates.confidence));
        if (updates.tags !== undefined) entry.tags = Array.isArray(updates.tags) ? updates.tags : [];
        if (updates.source !== undefined) {
            entry.source = { ...entry.source, ...updates.source };
        }
        entry.updatedAt = new Date().toISOString();

        // Re-embed if content changed
        const needsReembed = updates.content !== undefined;

        await putRecord('memoryEntries', entry);
        this._invalidateCache();
        eventBus.emit(Events.MEMORY_UPDATED, { entry });

        if (needsReembed) {
            // Delete old embedding and re-embed
            await deleteRecord('memoryEmbeddings', entryId);
            entry.embeddingStatus = 'pending';
            await putRecord('memoryEntries', entry);
            this._embedEntry(entry).catch(err => {
                console.warn('[Memory] Re-embedding failed for', entryId, err);
            });
        }

        return entry;
    }

    /**
     * Delete a memory entry and its embedding.
     * @param {string} entryId
     */
    async remove(entryId) {
        await deleteRecord('memoryEntries', entryId);
        await deleteRecord('memoryEmbeddings', entryId);
        this._invalidateCache();
        eventBus.emit(Events.MEMORY_DELETED, { entryId });
    }

    /**
     * Delete all memory for a project.
     * @param {string} projectId
     */
    async removeByProject(projectId) {
        const entries = await getRecordsByIndex('memoryEntries', 'projectId', projectId);
        for (const entry of entries) {
            await deleteRecord('memoryEmbeddings', entry.id);
        }
        await deleteByIndex('memoryEntries', 'projectId', projectId);
        this._invalidateCache();
    }

    /**
     * Get a single entry by ID.
     * @param {string} entryId
     * @returns {Promise<Object|undefined>}
     */
    async get(entryId) {
        return getRecord('memoryEntries', entryId);
    }

    /**
     * List all entries, optionally filtered by project and/or layer.
     * @param {Object} [opts]
     * @param {string} [opts.projectId]
     * @param {string} [opts.layer]
     * @returns {Promise<Object[]>}
     */
    async list(opts = {}) {
        await this._ensureCache();
        let results = [];
        for (const { entry } of this._cache.values()) {
            if (opts.projectId && entry.projectId !== opts.projectId) continue;
            if (opts.layer && entry.layer !== opts.layer) continue;
            results.push(entry);
        }
        results.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return results;
    }

    /**
     * Get count of entries.
     * @param {string} [projectId]
     * @returns {Promise<number>}
     */
    async count(projectId) {
        if (projectId) {
            const entries = await getRecordsByIndex('memoryEntries', 'projectId', projectId);
            return entries.length;
        }
        return countRecords('memoryEntries');
    }

    // ── Retrieval ─────────────────────────────────────────────────────────

    /**
     * Retrieve relevant memories for a query, respecting mode policies.
     * Combines vector similarity + keyword overlap, weighted 70/30.
     *
     * @param {string} query        - The user's message or search query
     * @param {string} mode         - Session mode (chat|research|compare|document|agent)
     * @param {Object} [opts]
     * @param {string} [opts.projectId] - Scope to a project (default: __global__)
     * @param {number} [opts.topK]      - Override policy topK
     * @param {number} [opts.threshold] - Override policy threshold
     * @returns {Promise<Array<{entry: Object, score: number, vectorScore: number, keywordScore: number}>>}
     */
    async retrieve(query, mode, opts = {}) {
        await this._ensureCache();

        const policy = MODE_POLICIES[mode] || MODE_POLICIES.chat;
        const topK = opts.topK ?? policy.topK;
        const threshold = opts.threshold ?? policy.threshold;
        const projectId = opts.projectId || DEFAULT_PROJECT;
        const layerSet = new Set(policy.layers);

        // Embed the query
        let queryVec = null;
        try {
            [queryVec] = await embeddingsService.embed(query);
        } catch (err) {
            console.warn('[Memory] Query embedding failed, falling back to keyword-only:', err);
        }

        const queryTokens = tokenize(query);
        const candidates = [];

        for (const { entry, vector, tokens } of this._cache.values()) {
            // Filter by project and layer
            if (entry.projectId !== projectId && entry.projectId !== DEFAULT_PROJECT) continue;
            if (!layerSet.has(entry.layer)) continue;

            // Vector similarity
            let vScore = 0;
            if (queryVec && vector) {
                vScore = cosineSimilarity(queryVec, vector);
            }

            // Keyword overlap
            const kScore = keywordScore(queryTokens, tokens);

            // Combined score: weighted blend
            const hasVector = queryVec && vector;
            let combined;
            if (hasVector) {
                combined = 0.7 * vScore + 0.3 * kScore;
            } else {
                combined = kScore; // keyword-only fallback
            }

            // Recency boost
            if (policy.boostRecent) {
                combined *= recencyBoost(entry.createdAt, entry.updatedAt);
            }

            // Confidence scaling
            combined *= (0.5 + 0.5 * entry.confidence);

            if (combined >= threshold) {
                candidates.push({ entry, score: combined, vectorScore: vScore, keywordScore: kScore });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        const results = candidates.slice(0, topK);

        // Update access counts
        for (const { entry } of results) {
            entry.accessCount = (entry.accessCount || 0) + 1;
            entry.lastAccessedAt = new Date().toISOString();
            putRecord('memoryEntries', entry).catch(() => {});
        }

        eventBus.emit(Events.MEMORY_SEARCHED, { query, mode, resultCount: results.length });
        return results;
    }

    /**
     * Retrieve and format memories for injection into a system prompt.
     * @param {string} query
     * @param {string} mode
     * @param {Object} [opts]
     * @returns {Promise<string>} Formatted context block (empty string if no results)
     */
    async retrieveContext(query, mode, opts = {}) {
        const results = await this.retrieve(query, mode, opts);
        if (results.length === 0) return '';

        const lines = ['[Semantic Memory — relevant facts and context recalled for this conversation]'];
        for (const { entry, score } of results) {
            const conf = (entry.confidence * 100).toFixed(0);
            const src = entry.source?.label || entry.source?.type;
            lines.push(
                `- [${entry.layer}|${conf}%|${src}] ${entry.content}`
            );
        }
        lines.push('[End of recalled memory]');
        return lines.join('\n');
    }

    // ── Search (explicit user search, all projects) ───────────────────────

    /**
     * Free-text search across all memories. For the memory panel UI.
     * @param {string} query
     * @param {Object} [opts]
     * @param {string} [opts.layer]     - Filter by layer
     * @param {string} [opts.projectId] - Filter by project
     * @param {number} [opts.limit=50]
     * @returns {Promise<Array<{entry: Object, score: number}>>}
     */
    async search(query, opts = {}) {
        await this._ensureCache();

        let queryVec = null;
        try {
            [queryVec] = await embeddingsService.embed(query);
        } catch (err) {
            console.warn('[Memory] Search embedding failed:', err);
        }

        const queryTokens = tokenize(query);
        const candidates = [];

        for (const { entry, vector, tokens } of this._cache.values()) {
            if (opts.layer && entry.layer !== opts.layer) continue;
            if (opts.projectId && entry.projectId !== opts.projectId) continue;

            let vScore = 0;
            if (queryVec && vector) {
                vScore = cosineSimilarity(queryVec, vector);
            }
            const kScore = keywordScore(queryTokens, tokens);

            const hasVector = queryVec && vector;
            const combined = hasVector ? 0.7 * vScore + 0.3 * kScore : kScore;

            if (combined > 0.05 || query.trim() === '') {
                candidates.push({ entry, score: combined });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, opts.limit || 50);
    }

    // ── Import / Export ───────────────────────────────────────────────────

    /**
     * Export all memory entries (without embeddings) as a JSON string.
     * Embeddings are re-generated on import.
     * @param {string} [projectId] - Export only a specific project
     * @returns {Promise<string>}
     */
    async exportMemory(projectId) {
        let entries;
        if (projectId) {
            entries = await getRecordsByIndex('memoryEntries', 'projectId', projectId);
        } else {
            entries = await getAllRecords('memoryEntries');
        }

        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            source: 'synapse-semantic-memory',
            count: entries.length,
            entries: entries.map(e => ({
                content: e.content,
                layer: e.layer,
                projectId: e.projectId,
                confidence: e.confidence,
                source: e.source,
                tags: e.tags,
                createdAt: e.createdAt,
                updatedAt: e.updatedAt
            }))
        };

        const json = JSON.stringify(payload, null, 2);
        eventBus.emit(Events.MEMORY_EXPORTED, { count: entries.length });
        return json;
    }

    /**
     * Import memory entries from a JSON string.
     * Validates structure, skips duplicates by content hash.
     *
     * @param {string} jsonString
     * @param {Object} [opts]
     * @param {boolean} [opts.merge=true]       - Skip duplicates
     * @param {string} [opts.overrideProjectId] - Remap all entries to a project
     * @returns {Promise<{ imported: number, skipped: number }>}
     */
    async importMemory(jsonString, opts = {}) {
        const data = JSON.parse(jsonString);
        if (!data.entries || !Array.isArray(data.entries)) {
            throw new Error('Invalid memory export format: missing entries array');
        }

        const merge = opts.merge !== false;

        // Build content dedup set if merging
        let existingContents = new Set();
        if (merge) {
            const existing = await getAllRecords('memoryEntries');
            for (const e of existing) {
                existingContents.add(`${e.projectId}:${e.layer}:${e.content}`);
            }
        }

        let imported = 0;
        let skipped = 0;
        const newEntries = [];

        for (const item of data.entries) {
            if (!item.content || !item.content.trim()) {
                skipped++;
                continue;
            }

            const projectId = opts.overrideProjectId || item.projectId || DEFAULT_PROJECT;
            const dedupKey = `${projectId}:${item.layer || 'fact'}:${item.content.trim()}`;

            if (merge && existingContents.has(dedupKey)) {
                skipped++;
                continue;
            }

            const entry = {
                id: generateId(),
                content: item.content.trim(),
                layer: item.layer || 'fact',
                projectId,
                confidence: Math.max(0, Math.min(1, item.confidence ?? 0.8)),
                source: {
                    type: item.source?.type || 'import',
                    chatId: item.source?.chatId || null,
                    label: item.source?.label || null
                },
                tags: Array.isArray(item.tags) ? item.tags : [],
                accessCount: 0,
                lastAccessedAt: null,
                createdAt: item.createdAt || new Date().toISOString(),
                updatedAt: item.updatedAt || new Date().toISOString(),
                embeddingStatus: 'pending'
            };

            await putRecord('memoryEntries', entry);
            newEntries.push(entry);
            imported++;
        }

        this._invalidateCache();
        eventBus.emit(Events.MEMORY_IMPORTED, { imported, skipped });

        // Embed all new entries in background
        this._embedBatch(newEntries).catch(err => {
            console.warn('[Memory] Batch embedding failed:', err);
        });

        return { imported, skipped };
    }

    // ── Compaction ────────────────────────────────────────────────────────

    /**
     * Compact memory by merging similar entries within the same layer/project.
     * Groups entries with high cosine similarity (>0.9) and merges them.
     *
     * @param {Object} [opts]
     * @param {string} [opts.projectId]
     * @param {string} [opts.layer]
     * @returns {Promise<{ merged: number }>}
     */
    async compact(opts = {}) {
        await this._ensureCache();

        const candidates = [];
        for (const { entry, vector } of this._cache.values()) {
            if (opts.projectId && entry.projectId !== opts.projectId) continue;
            if (opts.layer && entry.layer !== opts.layer) continue;
            if (!vector) continue; // skip entries without embeddings
            candidates.push({ entry, vector });
        }

        let merged = 0;
        const removed = new Set();

        for (let i = 0; i < candidates.length; i++) {
            if (removed.has(candidates[i].entry.id)) continue;
            for (let j = i + 1; j < candidates.length; j++) {
                if (removed.has(candidates[j].entry.id)) continue;
                if (candidates[i].entry.layer !== candidates[j].entry.layer) continue;

                const sim = cosineSimilarity(candidates[i].vector, candidates[j].vector);
                if (sim > 0.9) {
                    // Keep the one with higher confidence, or newer
                    const a = candidates[i].entry;
                    const b = candidates[j].entry;
                    const keep = (a.confidence >= b.confidence) ? a : b;
                    const drop = (a.confidence >= b.confidence) ? b : a;

                    // Merge tags
                    const mergedTags = [...new Set([...(keep.tags || []), ...(drop.tags || [])])];
                    keep.tags = mergedTags;
                    keep.updatedAt = new Date().toISOString();
                    keep.source = { ...keep.source, label: `merged:${drop.id}` };

                    await putRecord('memoryEntries', keep);
                    await this.remove(drop.id);
                    removed.add(drop.id);
                    merged++;
                }
            }
        }

        this._invalidateCache();
        eventBus.emit(Events.MEMORY_COMPACTED, { merged });
        return { merged };
    }

    // ── Clear ─────────────────────────────────────────────────────────────

    /**
     * Clear all memory entries and embeddings.
     */
    async clearAll() {
        await clearStore('memoryEntries');
        await clearStore('memoryEmbeddings');
        this._invalidateCache();
    }

    // ── Embedding ─────────────────────────────────────────────────────────

    /** @private Embed a single entry */
    async _embedEntry(entry) {
        try {
            const [vec] = await embeddingsService.embed(entry.content);
            if (!vec) return;

            await putRecord('memoryEmbeddings', {
                entryId: entry.id,
                projectId: entry.projectId,
                layer: entry.layer,
                vector: Array.from(vec)
            });

            entry.embeddingStatus = 'ready';
            await putRecord('memoryEntries', entry);
            this._invalidateCache();
        } catch (err) {
            entry.embeddingStatus = 'error';
            await putRecord('memoryEntries', entry);
            throw err;
        }
    }

    /** @private Embed a batch of entries sequentially */
    async _embedBatch(entries) {
        for (const entry of entries) {
            try {
                await this._embedEntry(entry);
            } catch {
                // Continue embedding others
            }
        }
    }

    // ── Stats ─────────────────────────────────────────────────────────────

    /**
     * Get memory statistics.
     * @returns {Promise<Object>}
     */
    async getStats() {
        const all = await getAllRecords('memoryEntries');
        const byLayer = {};
        for (const layer of LAYERS) byLayer[layer] = 0;
        const projects = new Set();
        let ready = 0, pending = 0, errored = 0;

        for (const e of all) {
            byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
            projects.add(e.projectId);
            if (e.embeddingStatus === 'ready') ready++;
            else if (e.embeddingStatus === 'error') errored++;
            else pending++;
        }

        return {
            total: all.length,
            byLayer,
            projectCount: projects.size,
            embedded: { ready, pending, errored }
        };
    }

    /**
     * Get the current mode policy for inspection.
     * @param {string} mode
     * @returns {Object}
     */
    getPolicy(mode) {
        return MODE_POLICIES[mode] || MODE_POLICIES.chat;
    }

    /**
     * Get all valid layer names.
     * @returns {string[]}
     */
    getLayers() {
        return [...LAYERS];
    }

    /**
     * Get all distinct project IDs in use.
     * @returns {Promise<string[]>}
     */
    async getProjects() {
        const all = await getAllRecords('memoryEntries');
        const set = new Set(all.map(e => e.projectId));
        return [...set].sort();
    }
}

export const memoryService = new MemoryService();

/**
 * RAGService — Retrieval-Augmented Generation orchestrator.
 *
 * Documents are scoped per-chat. Drop files into the chat input →
 * auto-chunk → auto-embed → context auto-injected into prompts.
 */

import {
    putRecord, putRecords, getRecord, getAllRecords,
    getRecordsByIndex, deleteRecord, deleteByIndex, countRecords
} from './idbStore.js?v=36';
import { embeddingsService } from './embeddingsService.js?v=36';
import { storageService } from './storageService.js?v=36';
import { eventBus, Events } from '../utils/eventBus.js?v=36';

// ── Helpers ──────────────────────────────────────────────────────────────

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

// ── Text chunking ────────────────────────────────────────────────────────

const SEPARATORS = ['\n\n', '\n', '. ', ' '];

function chunkText(text, size = 512, overlap = 64) {
    if (text.length <= size) return [text];
    return _splitRecursive(text, size, overlap, 0);
}

function _splitRecursive(text, size, overlap, sepIdx) {
    if (text.length <= size) return [text];

    const sep = SEPARATORS[sepIdx];
    if (!sep) {
        const chunks = [];
        for (let i = 0; i < text.length; i += size - overlap) {
            chunks.push(text.slice(i, i + size));
        }
        return chunks;
    }

    const parts = text.split(sep);
    const chunks = [];
    let current = '';

    for (const part of parts) {
        const candidate = current ? current + sep + part : part;

        if (candidate.length > size && current) {
            chunks.push(current);
            const overlapStart = Math.max(0, current.length - overlap);
            current = current.slice(overlapStart) + sep + part;
            if (current.length > size) {
                chunks.push(..._splitRecursive(current, size, overlap, sepIdx + 1));
                current = '';
            }
        } else {
            current = candidate;
        }
    }

    if (current) {
        if (current.length > size) {
            chunks.push(..._splitRecursive(current, size, overlap, sepIdx + 1));
        } else {
            chunks.push(current);
        }
    }

    return chunks;
}

// ── PDF text extraction ──────────────────────────────────────────────────

async function extractPdfText(file) {
    if (!window.pdfjsLib) {
        throw new Error('PDF.js not loaded. Refresh the page and try again.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        pages.push(tc.items.map(item => item.str).join(' '));
    }
    return pages.join('\n\n');
}

async function extractFileText(file) {
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        return extractPdfText(file);
    }
    return file.text();
}

// ── Service ──────────────────────────────────────────────────────────────

class RAGService {
    constructor() {
        /** @type {Map<string, AbortController>} docId → active embedding job */
        this._embeddingJobs = new Map();
    }

    // ── Document ingestion ───────────────────────────────────────────────

    /**
     * Ingest a File object scoped to a specific chat.
     * Extracts text, chunks, stores, and auto-embeds.
     *
     * @param {File} file - browser File object (PDF, TXT, MD)
     * @param {string} chatId - the chat this document belongs to
     * @returns {Promise<Object>} The created document record
     */
    async ingestFile(file, chatId) {
        const content = await extractFileText(file);

        const settings = storageService.loadSettings();
        const chunkSize = settings.ragChunkSize || 512;
        const chunkOverlap = settings.ragChunkOverlap || 64;

        const docId = generateId();
        const doc = {
            id: docId,
            chatId,
            collectionId: chatId, // reuse collectionId index for chat scoping
            name: file.name,
            type: file.type || 'text/plain',
            charCount: content.length,
            chunkCount: 0,
            embeddingStatus: 'chunking',
            createdAt: new Date().toISOString()
        };

        const textChunks = chunkText(content, chunkSize, chunkOverlap);
        const chunkRecords = textChunks.map((text, idx) => ({
            id: generateId(),
            documentId: docId,
            collectionId: chatId,
            index: idx,
            text
        }));

        doc.chunkCount = chunkRecords.length;
        await putRecord('ragDocuments', doc);
        if (chunkRecords.length > 0) {
            await putRecords('ragChunks', chunkRecords);
        }

        eventBus.emit(Events.RAG_DOCUMENTS_ADDED, { document: doc, chatId });

        // Auto-embed in background
        this._embedDocument(doc, chunkRecords).catch(err => {
            console.error('[RAG] Background embedding failed:', err);
        });

        return doc;
    }

    /** @private */
    async _embedDocument(doc, chunkRecords) {
        const abortController = new AbortController();
        this._embeddingJobs.set(doc.id, abortController);

        try {
            doc.embeddingStatus = 'embedding';
            await putRecord('ragDocuments', doc);
            eventBus.emit(Events.RAG_EMBEDDING_PROGRESS, {
                documentId: doc.id,
                completed: 0,
                total: chunkRecords.length
            });

            const texts = chunkRecords.map(c => c.text);
            const vectors = await embeddingsService.embedBatch(texts, {
                signal: abortController.signal,
                batchSize: 32,
                onProgress: (completed, total) => {
                    eventBus.emit(Events.RAG_EMBEDDING_PROGRESS, {
                        documentId: doc.id,
                        completed,
                        total
                    });
                }
            });

            const embeddingRecords = chunkRecords.map((chunk, i) => ({
                chunkId: chunk.id,
                documentId: doc.id,
                collectionId: doc.chatId,
                vector: Array.from(vectors[i])
            }));

            await putRecords('ragEmbeddings', embeddingRecords);

            doc.embeddingStatus = 'ready';
            await putRecord('ragDocuments', doc);
            eventBus.emit(Events.RAG_EMBEDDING_COMPLETE, { documentId: doc.id, chatId: doc.chatId });

        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('[RAG] Embedding failed for', doc.name, err);
            doc.embeddingStatus = 'error';
            await putRecord('ragDocuments', doc);
            eventBus.emit(Events.RAG_EMBEDDING_ERROR, { documentId: doc.id, error: err.message });
        } finally {
            this._embeddingJobs.delete(doc.id);
        }
    }

    // ── Document management ──────────────────────────────────────────────

    /** List documents for a specific chat. */
    async listDocuments(chatId) {
        return getRecordsByIndex('ragDocuments', 'collectionId', chatId);
    }

    /** Check if a chat has any ready (embedded) documents. */
    async hasReadyDocuments(chatId) {
        const docs = await this.listDocuments(chatId);
        return docs.some(d => d.embeddingStatus === 'ready');
    }

    /** Delete a single document and its chunks + embeddings. */
    async deleteDocument(documentId) {
        this._embeddingJobs.get(documentId)?.abort();
        this._embeddingJobs.delete(documentId);

        await deleteByIndex('ragEmbeddings', 'documentId', documentId);
        await deleteByIndex('ragChunks', 'documentId', documentId);
        await deleteRecord('ragDocuments', documentId);
        eventBus.emit(Events.RAG_DOCUMENT_DELETED, { documentId });
    }

    /** Delete all documents for a chat. */
    async deleteChatDocuments(chatId) {
        const docs = await this.listDocuments(chatId);
        for (const doc of docs) {
            await this.deleteDocument(doc.id);
        }
    }

    // ── Search (scoped to a chat) ────────────────────────────────────────

    /**
     * Semantic search across a chat's documents.
     * @param {string} query
     * @param {string} chatId
     * @param {object} [opts]
     * @param {number} [opts.topK]
     * @param {number} [opts.threshold]
     * @returns {Promise<Array<{chunkId: string, documentId: string, text: string, score: number, documentName: string}>>}
     */
    async search(query, chatId, opts = {}) {
        const settings = storageService.loadSettings();
        const topK = opts.topK || settings.ragTopK || 5;
        const threshold = opts.threshold ?? settings.ragSimilarityThreshold ?? 0.3;

        const [queryVec] = await embeddingsService.embed(query);

        // Only get embeddings for this chat
        const allEmbeddings = await getRecordsByIndex('ragEmbeddings', 'collectionId', chatId);
        if (allEmbeddings.length === 0) return [];

        const scored = allEmbeddings.map(emb => ({
            ...emb,
            score: cosineSimilarity(queryVec, new Float32Array(emb.vector))
        }));

        scored.sort((a, b) => b.score - a.score);
        const top = scored.filter(s => s.score >= threshold).slice(0, topK);

        const results = await Promise.all(top.map(async (item) => {
            const chunk = await getRecord('ragChunks', item.chunkId);
            const doc = await getRecord('ragDocuments', item.documentId);
            return {
                chunkId: item.chunkId,
                documentId: item.documentId,
                text: chunk?.text || '',
                score: item.score,
                documentName: doc?.name || 'Unknown'
            };
        }));

        eventBus.emit(Events.RAG_SEARCH_EXECUTED, { query, chatId, resultCount: results.length });
        return results;
    }

    /**
     * Format search results for injection into a system prompt.
     * @param {Array} results
     * @returns {string}
     */
    formatContext(results) {
        if (results.length === 0) return '';
        const parts = results.map((r, i) =>
            `[Source ${i + 1}: ${r.documentName} (relevance: ${(r.score * 100).toFixed(0)}%)]\n${r.text}`
        );
        return parts.join('\n\n');
    }
}

export const ragService = new RAGService();

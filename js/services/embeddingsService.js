/**
 * EmbeddingsService — Generates vector embeddings via Ollama or LM Studio.
 *
 * Ollama:    POST /api/embed   { model, input }
 * LM Studio: POST /v1/embeddings { model, input }
 *
 * Both accept a single string or an array of strings and return an array of
 * float vectors. This service normalises the response into Float32Arrays.
 */

import { providerManager } from './providerManager.js';
import { storageService } from './storageService.js';

class EmbeddingsService {
    constructor() {
        /** @type {AbortController|null} */
        this._abort = null;
    }

    // ── Public API ───────────────────────────────────────────────────────

    /**
     * Embed one or more texts and return normalised Float32Array vectors.
     * @param {string|string[]} input - text(s) to embed
     * @param {object} [opts]
     * @param {string} [opts.model]    - override model (default from settings)
     * @param {string} [opts.provider] - override provider name
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<Float32Array[]>}
     */
    async embed(input, opts = {}) {
        const texts = Array.isArray(input) ? input : [input];
        if (texts.length === 0) return [];

        const settings = storageService.loadSettings();
        const providerName = opts.provider || providerManager.getProviderName();
        const baseUrl = providerManager.getProviderUrl(providerName);

        // Pick the embedding model configured for the active provider
        const model = opts.model || (providerName === 'ollama'
            ? settings.ragEmbeddingsModelOllama
            : settings.ragEmbeddingsModelLmstudio);

        if (!model) {
            throw new Error(
                `No embedding model configured for ${providerName}. Select one in Settings → Knowledge Base.`
            );
        }

        if (providerName === 'ollama') {
            return this._embedOllama(baseUrl, model, texts, opts.signal);
        }
        return this._embedOpenAI(baseUrl, model, texts, opts.signal);
    }

    /**
     * Embed texts in batches, calling a progress callback after each batch.
     * @param {string[]} texts
     * @param {object} [opts]
     * @param {number}   [opts.batchSize=32]
     * @param {function} [opts.onProgress] - (completed, total) => void
     * @param {string}   [opts.model]
     * @param {string}   [opts.provider]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<Float32Array[]>}
     */
    async embedBatch(texts, opts = {}) {
        const batchSize = opts.batchSize || 32;
        const results = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const vectors = await this.embed(batch, {
                model: opts.model,
                provider: opts.provider,
                signal: opts.signal
            });
            results.push(...vectors);
            opts.onProgress?.(Math.min(i + batchSize, texts.length), texts.length);
        }

        return results;
    }

    /**
     * Get the dimensionality of the configured embedding model by embedding
     * a probe string. Useful for pre-allocating storage.
     * @returns {Promise<number>}
     */
    async getDimensions() {
        const [vec] = await this.embed('dimension probe');
        return vec.length;
    }

    abort() {
        if (this._abort) {
            this._abort.abort();
            this._abort = null;
        }
    }

    // ── Provider-specific implementations ────────────────────────────────

    /** @private */
    async _embedOllama(baseUrl, model, texts, signal) {
        const res = await fetch(`${baseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts }),
            signal
        });

        if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            throw new Error(`Ollama embeddings failed (${res.status}): ${err}`);
        }

        const data = await res.json();
        // Ollama returns { embeddings: [[...], [...]] }
        return (data.embeddings || []).map(v => new Float32Array(v));
    }

    /** @private */
    async _embedOpenAI(baseUrl, model, texts, signal) {
        const res = await fetch(`${baseUrl}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts }),
            signal
        });

        if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            throw new Error(`Embeddings failed (${res.status}): ${err}`);
        }

        const data = await res.json();
        // OpenAI format: { data: [{ embedding: [...], index: 0 }, ...] }
        const sorted = (data.data || []).sort((a, b) => a.index - b.index);
        return sorted.map(d => new Float32Array(d.embedding));
    }
}

export const embeddingsService = new EmbeddingsService();

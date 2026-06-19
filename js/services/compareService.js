/**
 * CompareService — Multi-model compare & committee mode.
 *
 * Runs 2–3 models concurrently against a single shared prompt and (optionally)
 * synthesizes a unified committee answer. Each session is persisted to the
 * `compareSessions` IDB store so comparisons can be rated, exported, reopened,
 * and reviewed later.
 *
 * Execution model:
 *   - Each entry is run through the relevant provider's `chat()` with its OWN
 *     AbortController signal, so comparisons run concurrently and never touch
 *     the main chat stream (we always pass `options.signal`).
 *   - Capability-aware: if a provider is offline or a model isn't installed,
 *     the entry falls back to a clearly-marked SIMULATED response rather than
 *     breaking. Statuses stay explicit (pending/streaming/completed/error/
 *     simulated/aborted).
 *
 * No new dependencies. Uses providerManager + idbStore primitives.
 */

import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';
import { providerManager } from './providerManager.js';
import { storageService } from './storageService.js';

const STORE = 'compareSessions';
const MAX_ENTRIES = 3;
const MIN_ENTRIES = 2;

const MODES = ['compare', 'committee'];
const ENTRY_STATUSES = ['pending', 'streaming', 'completed', 'error', 'simulated', 'aborted'];
const SESSION_STATUSES = ['draft', 'running', 'completed', 'partial', 'error'];
const SYNTH_STATUSES = ['pending', 'streaming', 'completed', 'error', 'simulated', 'skipped'];

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_CTX = 4096;
const CAPABILITY_TTL_MS = 30000;

const SYNTHESIS_SYSTEM =
    'You are the non-partisan chair of an AI review committee. ' +
    'You are given several responses to the SAME prompt and must produce a single, ' +
    'well-reasoned unified answer. Reconcile disagreements, correct errors, and note ' +
    'which response(s) contributed each key point. Be concise and accurate.';

function now() {
    return new Date().toISOString();
}

function id(prefix = 'cmp') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function slug(value) {
    return String(value || 'compare-session')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'compare-session';
}

function titleFromPrompt(prompt) {
    const cleaned = String(prompt || '').trim().replace(/\s+/g, ' ');
    return cleaned ? (cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned) : 'Compare session';
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Normalize stats from either provider's chat() result into a common shape.
 * Ollama returns evalCount/evalDuration (ns); LM Studio returns token counts.
 * @private
 */
function normalizeStats(result = {}) {
    const evalCount = result.evalCount ?? result.completionTokens ?? null;
    const promptTokens = result.promptEvalCount ?? result.promptTokens ?? null;
    const evalDurationNs = result.evalDuration ?? null;
    const totalDurationNs = result.totalDuration ?? null;
    let tokensPerSecond = null;
    if (evalCount && evalDurationNs) {
        const seconds = evalDurationNs / 1e9;
        if (seconds > 0) tokensPerSecond = Math.round((evalCount / seconds) * 10) / 10;
    }
    return {
        evalCount: evalCount !== null ? Number(evalCount) : null,
        promptTokens: promptTokens !== null ? Number(promptTokens) : null,
        tokensPerSecond
    };
}

function normalizeEntry(input = {}) {
    const provider = input.provider || providerManager.getProviderName() || 'ollama';
    return {
        id: input.id || id('cmp_e'),
        provider,
        model: input.model || null,
        status: ENTRY_STATUSES.includes(input.status) ? input.status : 'pending',
        content: input.content || '',
        thinking: input.thinking || '',
        error: input.error || null,
        stats: input.stats || null,
        simulated: Boolean(input.simulated),
        rating: clampInt(input.rating, 0, 5, 0),
        ratingNote: input.ratingNote || '',
        revealed: Boolean(input.revealed),
        startedAt: input.startedAt || null,
        completedAt: input.completedAt || null
    };
}

function normalizeSynthesis(input = {}) {
    return {
        status: SYNTH_STATUSES.includes(input.status) ? input.status : 'skipped',
        content: input.content || '',
        error: input.error || null,
        simulated: Boolean(input.simulated),
        provider: input.provider || null,
        model: input.model || null,
        updatedAt: input.updatedAt || null
    };
}

function normalizeSession(input = {}) {
    const timestamp = now();
    const rawEntries = Array.isArray(input.entries) ? input.entries : [];
    const entries = rawEntries.slice(0, MAX_ENTRIES).map(normalizeEntry);

    // Seed at least MIN_ENTRIES so the UI has something to show.
    while (entries.length < MIN_ENTRIES) {
        entries.push(normalizeEntry({ provider: providerManager.getProviderName() }));
    }

    const mode = MODES.includes(input.mode) ? input.mode : 'compare';
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const title = input.title || titleFromPrompt(prompt);

    return {
        id: input.id || id('cmp'),
        title,
        prompt,
        systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
        mode,
        blind: Boolean(input.blind),
        temperature: Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : DEFAULT_TEMPERATURE,
        maxCtx: clampInt(input.maxCtx, 512, 131072, DEFAULT_MAX_CTX),
        projectId: input.projectId || 'default',
        status: SESSION_STATUSES.includes(input.status) ? input.status : 'draft',
        entries,
        synthesis: normalizeSynthesis(input.synthesis),
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

class CompareService {
    constructor() {
        /** Live session objects keyed by id while a run is in progress. @type {Map<string,object>} */
        this._live = new Map();
        /** Per-session AbortControllers currently in flight. @type {Map<string,Set<AbortController>>} */
        this._controllers = new Map();
        /** Per-session persist-coalescing flags. @type {Set<string>} */
        this._persistPending = new Set();
        /** Capability cache keyed by provider name. @type {Map<string,object>} */
        this._capCache = new Map();
    }

    listModes() { return MODES; }
    listEntryStatuses() { return ENTRY_STATUSES; }
    listSessionStatuses() { return SESSION_STATUSES; }
    getEntryLimits() { return { min: MIN_ENTRIES, max: MAX_ENTRIES }; }

    // ─── Capability (provider / model) resolution ─────────────────────────

    /**
     * List available models for a provider, with short caching.
     * @param {string} providerName
     * @returns {Promise<{available:boolean, models:string[]}>}
     */
    async getModels(providerName) {
        const cap = await this._resolveCapability(providerName, null);
        return { available: cap.available, models: cap.models };
    }

    /**
     * Resolve whether a provider is online and (optionally) whether a model is installed.
     * @private
     */
    async _resolveCapability(providerName, model) {
        providerName = providerName || providerManager.getProviderName();
        let cap = this._capCache.get(providerName);
        if (!cap || (Date.now() - cap.ts > CAPABILITY_TTL_MS)) {
            const provider = providerManager.getProviderByName(providerName);
            let available = false;
            let models = [];
            if (provider) {
                try {
                    available = Boolean(await provider.isServerAvailable());
                } catch {
                    available = false;
                }
                if (available) {
                    try {
                        const list = await provider.listModels();
                        models = (list || []).map(m => m.name).filter(Boolean);
                    } catch {
                        models = [];
                    }
                }
            }
            cap = { ts: Date.now(), available, models, modelSet: new Set(models) };
            this._capCache.set(providerName, cap);
        }
        const hasModel = model ? cap.modelSet.has(model) : true;
        return { available: cap.available, hasModel, models: cap.models };
    }

    /** Force a refresh of cached capabilities (e.g. after the user pulls a model). */
    invalidateCapabilities(providerName) {
        if (providerName) {
            this._capCache.delete(providerName);
        } else {
            this._capCache.clear();
        }
    }

    // ─── CRUD ─────────────────────────────────────────────────────────────

    async list(filters = {}) {
        let sessions = await getAllRecords(STORE);
        const query = String(filters.query || '').trim().toLowerCase();
        if (filters.mode) sessions = sessions.filter(s => s.mode === filters.mode);
        if (filters.blind !== undefined) sessions = sessions.filter(s => Boolean(s.blind) === Boolean(filters.blind));
        if (filters.status) sessions = sessions.filter(s => s.status === filters.status);
        if (filters.projectId) sessions = sessions.filter(s => s.projectId === filters.projectId);
        if (query) {
            sessions = sessions.filter(s => {
                const hay = [
                    s.title, s.prompt, s.mode, s.status,
                    ...(s.entries || []).flatMap(e => [e.provider, e.model, e.content])
                ].join(' ').toLowerCase();
                return hay.includes(query);
            });
        }
        sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return sessions;
    }

    async get(sessionId) {
        return getRecord(STORE, sessionId);
    }

    /** Create a draft session seeded from current provider/model. */
    async create(input = {}) {
        const provider = providerManager.getProviderName() || 'ollama';
        const settings = storageService.loadSettings();
        const model = input.model || settings.selectedModel || null;

        const seedEntries = [
            { provider, model },
            { provider, model }
        ];
        if (Array.isArray(input.entries) && input.entries.length) {
            // caller-provided entries win
            seedEntries.length = 0;
            for (const e of input.entries.slice(0, MAX_ENTRIES)) seedEntries.push(e);
        }

        const session = normalizeSession({ ...input, entries: seedEntries });
        await putRecord(STORE, this._snapshot(session));
        return session;
    }

    /** Patch top-level config (prompt, mode, blind, model choices, etc.). */
    async update(sessionId, patch = {}) {
        const existing = this._live.get(sessionId) || await this.get(sessionId);
        if (!existing) throw new Error(`Compare session not found: ${sessionId}`);

        const merged = { ...existing };
        if (patch.title !== undefined) merged.title = String(patch.title);
        if (patch.prompt !== undefined) merged.prompt = String(patch.prompt);
        if (patch.systemPrompt !== undefined) merged.systemPrompt = String(patch.systemPrompt);
        if (patch.mode !== undefined && MODES.includes(patch.mode)) merged.mode = patch.mode;
        if (patch.blind !== undefined) merged.blind = Boolean(patch.blind);
        if (patch.temperature !== undefined) merged.temperature = Number.isFinite(Number(patch.temperature)) ? Number(patch.temperature) : merged.temperature;
        if (patch.maxCtx !== undefined) merged.maxCtx = clampInt(patch.maxCtx, 512, 131072, merged.maxCtx);
        if (patch.projectId !== undefined) merged.projectId = String(patch.projectId);
        if (Array.isArray(patch.entries)) {
            merged.entries = patch.entries.slice(0, MAX_ENTRIES).map(e =>
                normalizeEntry({ ...(merged.entries.find(x => x.id === e.id) || {}), ...e })
            );
            while (merged.entries.length < MIN_ENTRIES) {
                merged.entries.push(normalizeEntry({ provider: providerManager.getProviderName() }));
            }
        }
        merged.updatedAt = now();

        const normalized = normalizeSession(merged);
        if (this._live.has(sessionId)) this._live.set(sessionId, normalized);
        await putRecord(STORE, this._snapshot(normalized));
        return normalized;
    }

    async delete(sessionId) {
        this.stop(sessionId);
        this._live.delete(sessionId);
        await deleteRecord(STORE, sessionId);
    }

    // ─── Execution ────────────────────────────────────────────────────────

    isRunning(sessionId) {
        const controllers = this._controllers.get(sessionId);
        return Boolean(controllers && controllers.size > 0);
    }

    /**
     * Abort every in-flight entry for a session.
     */
    stop(sessionId) {
        const set = this._controllers.get(sessionId);
        if (set) {
            for (const controller of set) {
                try { controller.abort(); } catch { /* ignore */ }
            }
        }
    }

    /**
     * Run all entries concurrently against the shared prompt.
     * @param {string} sessionId
     * @param {Object} [callbacks]
     * @param {(entry:object)=>void} [callbacks.onEntryStatus] - status transitions
     * @param {(entry:object)=>void} [callbacks.onEntryChunk] - streamed content updates
     * @param {(session:object)=>void} [callbacks.onSessionStatus] - session-level status
     * @returns {Promise<object>} The finalized session snapshot.
     */
    async run(sessionId, callbacks = {}) {
        const { onEntryStatus, onEntryChunk, onSessionStatus } = callbacks;
        const stored = await this.get(sessionId);
        if (!stored) throw new Error(`Compare session not found: ${sessionId}`);

        // Reset entries for a fresh run.
        const session = normalizeSession(stored);
        session.status = 'running';
        session.entries = session.entries.map(e => normalizeEntry({
            ...e,
            status: 'pending',
            content: '',
            thinking: '',
            error: null,
            stats: null,
            simulated: false,
            startedAt: null,
            completedAt: null
        }));
        session.synthesis = normalizeSynthesis({ status: session.mode === 'committee' ? 'pending' : 'skipped' });
        if (stored.title === 'Compare session' || !stored.prompt) {
            session.title = titleFromPrompt(session.prompt);
        }

        this._live.set(sessionId, session);
        this._controllers.set(sessionId, new Set());
        onSessionStatus?.(this._readonly(session));
        this._persist(sessionId);

        await Promise.allSettled(session.entries.map(entry =>
            this._runEntry(sessionId, entry, { onEntryStatus, onEntryChunk })
        ));

        // Finalize session status from entry outcomes.
        const statuses = session.entries.map(e => e.status);
        const allDone = statuses.every(s => s === 'completed' || s === 'simulated');
        const noneDone = statuses.every(s => s === 'error' || s === 'aborted');
        session.status = noneDone ? 'error' : (allDone ? 'completed' : 'partial');
        onSessionStatus?.(this._readonly(session));
        this._persist(sessionId);
        await putRecord(STORE, this._snapshot(session));
        this._controllers.delete(sessionId);

        return this._readonly(session);
    }

    /** @private */
    async _runEntry(sessionId, entry, { onEntryStatus, onEntryChunk }) {
        const session = this._live.get(sessionId);
        if (!session) return;

        const cap = await this._resolveCapability(entry.provider, entry.model);
        if (!entry.model || !cap.available || !cap.hasModel) {
            // Capability-aware simulation fallback.
            entry.simulated = true;
            entry.status = 'simulated';
            entry.startedAt = now();
            entry.completedAt = now();
            entry.error = null;
            entry.content = this._simulatedResponse(entry, cap);
            onEntryStatus?.(this._readonlyEntry(entry));
            onEntryChunk?.(this._readonlyEntry(entry));
            this._persist(sessionId);
            return;
        }

        const provider = providerManager.getProviderByName(entry.provider);
        const controller = new AbortController();
        this._controllers.get(sessionId)?.add(controller);

        entry.simulated = false;
        entry.status = 'streaming';
        entry.error = null;
        entry.startedAt = now();
        onEntryStatus?.(this._readonlyEntry(entry));
        this._persist(sessionId);

        try {
            const messages = this._buildMessages(session, entry);
            const result = await provider.chat(
                entry.model,
                messages,
                (chunk) => {
                    if (typeof chunk?.fullContent === 'string') entry.content = chunk.fullContent;
                    if (typeof chunk?.fullThinking === 'string') entry.thinking = chunk.fullThinking;
                    onEntryChunk?.(this._readonlyEntry(entry));
                },
                {
                    signal: controller.signal,
                    options: { temperature: session.temperature, num_ctx: session.maxCtx }
                }
            );

            if (result?.content) entry.content = result.content;
            if (result?.thinking) entry.thinking = result.thinking;
            entry.stats = normalizeStats(result);
            entry.status = entry.content ? 'completed' : 'error';
            if (!entry.content) entry.error = 'Model returned an empty response';
        } catch (err) {
            if (err?.name === 'AbortError') {
                entry.status = 'aborted';
                entry.error = null;
            } else {
                entry.status = 'error';
                entry.error = err?.message || String(err);
                console.error(`[CompareService] entry ${entry.provider}/${entry.model} failed:`, err);
            }
        } finally {
            entry.completedAt = now();
            this._controllers.get(sessionId)?.delete(controller);
            onEntryStatus?.(this._readonlyEntry(entry));
            this._persist(sessionId);
        }
    }

    /** @private */
    _buildMessages(session, entry) {
        const messages = [];
        if (session.systemPrompt && session.systemPrompt.trim()) {
            messages.push({ role: 'system', content: session.systemPrompt });
        }
        messages.push({ role: 'user', content: session.prompt });
        return messages;
    }

    /** @private */
    _simulatedResponse(entry, cap) {
        const providerLabel = providerManager.getProviderByName(entry.provider)
            ? providerManager.getProviderLabel(entry.provider) : entry.provider;
        let reason;
        if (!entry.model) reason = `no model is selected for this slot`;
        else if (!cap.available) reason = `${providerLabel} is not reachable`;
        else reason = `model "${entry.model}" is not installed in ${providerLabel}`;
        return [
            `> ⚠️ **Simulated response (capability fallback)**`,
            ``,
            `No network call was made. ${reason.charAt(0).toUpperCase() + reason.slice(1)}.`,
            ``,
            `This slot is preserved so the rest of the comparison can proceed. Connect the ` +
            `provider and ensure the model is pulled, then re-run to replace this placeholder ` +
            `with a real response from \`${entry.provider}/${entry.model || 'unset'}\`.`
        ].join('\n');
    }

    // ─── Committee synthesis ──────────────────────────────────────────────

    /**
     * Generate a committee synthesis from completed entries.
     * @param {string} sessionId
     * @param {string} [chairEntryId] - entry whose provider/model chairs the synthesis
     * @param {Object} [callbacks]
     * @returns {Promise<object>} updated session
     */
    async runSynthesis(sessionId, chairEntryId, callbacks = {}) {
        const { onChunk, onStatus } = callbacks;
        const session = this._live.get(sessionId) || await this.get(sessionId);
        if (!session) throw new Error(`Compare session not found: ${sessionId}`);
        if (!this._controllers.has(sessionId)) this._controllers.set(sessionId, new Set());

        const usable = session.entries.filter(e => e.content && (e.status === 'completed' || e.status === 'simulated'));
        if (usable.length < 2) {
            session.synthesis = normalizeSynthesis({ status: 'skipped', content: '', updatedAt: now() });
            onStatus?.(session.synthesis);
            await this._persistNow(sessionId, session);
            return this._readonly(session);
        }

        const chair = (chairEntryId && session.entries.find(e => e.id === chairEntryId)) || usable[0];
        const cap = await this._resolveCapability(chair.provider, chair.model);
        if (!chair.model || !cap.available || !cap.hasModel) {
            const synth = normalizeSynthesis({
                status: 'simulated',
                simulated: true,
                provider: chair.provider,
                model: chair.model,
                content: this._simulatedSynthesis(session, usable),
                updatedAt: now()
            });
            session.synthesis = synth;
            onStatus?.(synth);
            await this._persistNow(sessionId, session);
            return this._readonly(session);
        }

        const provider = providerManager.getProviderByName(chair.provider);
        const controller = new AbortController();
        this._controllers.get(sessionId)?.add(controller);

        const synth = normalizeSynthesis({
            status: 'streaming',
            provider: chair.provider,
            model: chair.model,
            content: '',
            updatedAt: now()
        });
        session.synthesis = synth;
        onStatus?.(synth);
        this._persist(sessionId);

        try {
            const messages = [
                { role: 'system', content: SYNTHESIS_SYSTEM },
                { role: 'user', content: this._buildSynthesisPrompt(session, usable) }
            ];
            const result = await provider.chat(
                chair.model,
                messages,
                (chunk) => {
                    if (typeof chunk?.fullContent === 'string') {
                        session.synthesis.content = chunk.fullContent;
                        onChunk?.(session.synthesis);
                    }
                },
                { signal: controller.signal, options: { temperature: 0.4, num_ctx: session.maxCtx } }
            );
            session.synthesis.content = result?.content || session.synthesis.content;
            session.synthesis.status = session.synthesis.content ? 'completed' : 'error';
            if (!session.synthesis.content) session.synthesis.error = 'Empty synthesis response';
        } catch (err) {
            if (err?.name === 'AbortError') {
                session.synthesis.status = 'skipped';
            } else {
                session.synthesis.status = 'error';
                session.synthesis.error = err?.message || String(err);
                console.error('[CompareService] synthesis failed:', err);
            }
        } finally {
            session.synthesis.updatedAt = now();
            this._controllers.get(sessionId)?.delete(controller);
            onStatus?.(session.synthesis);
            await this._persistNow(sessionId, session);
            if (!this.isRunning(sessionId)) this._controllers.delete(sessionId);
        }
        return this._readonly(session);
    }

    /** @private */
    _buildSynthesisPrompt(session, entries) {
        const labeled = entries.map((e, i) => {
            const label = session.blind
                ? String.fromCharCode(65 + i)
                : `${e.provider}/${e.model}`;
            return `### Response ${label}\n${e.content}`;
        }).join('\n\n');
        return [
            `Several AI models responded to the SAME prompt. Synthesize the best unified answer.`,
            ``,
            `ORIGINAL PROMPT:`,
            session.prompt,
            ``,
            labeled,
            ``,
            `Write a single unified answer. Then add a short "### Committee notes" section ` +
            `listing the main agreements, disagreements, and any errors you corrected, naming ` +
            `responses by their label.`
        ].join('\n');
    }

    /** @private */
    _simulatedSynthesis(session, entries) {
        const labels = entries.map((e, i) =>
            session.blind ? String.fromCharCode(65 + i) : `${e.provider}/${e.model}`
        ).join(', ');
        return [
            `> ⚠️ **Simulated synthesis (capability fallback)**`,
            ``,
            `No chair model was reachable, so this is a structural placeholder, not a real synthesis.`,
            `Collected responses from: ${labels}.`,
            ``,
            `Run a synthesis once a capable chair model is available to merge these into one answer.`
        ].join('\n');
    }

    // ─── Ratings / reveal ─────────────────────────────────────────────────

    async setRating(sessionId, entryId, rating, note) {
        const existing = this._live.get(sessionId) || await this.get(sessionId);
        if (!existing) throw new Error(`Compare session not found: ${sessionId}`);
        const entry = existing.entries.find(e => e.id === entryId);
        if (!entry) throw new Error(`Entry not found: ${entryId}`);
        entry.rating = clampInt(rating, 0, 5, 0);
        if (note !== undefined) entry.ratingNote = String(note || '');
        existing.updatedAt = now();
        if (this._live.has(sessionId)) this._live.set(sessionId, existing);
        await putRecord(STORE, this._snapshot(existing));
        return this._readonlyEntry(entry);
    }

    async revealEntry(sessionId, entryId, revealed = true) {
        const existing = this._live.get(sessionId) || await this.get(sessionId);
        if (!existing) throw new Error(`Compare session not found: ${sessionId}`);
        const entry = existing.entries.find(e => e.id === entryId);
        if (entry) {
            entry.revealed = Boolean(revealed);
            existing.updatedAt = now();
            if (this._live.has(sessionId)) this._live.set(sessionId, existing);
            await putRecord(STORE, this._snapshot(existing));
        }
        return this._readonlyEntry(entry);
    }

    /** Reveal all entries (e.g. when leaving blind mode). */
    async revealAll(sessionId, revealed = true) {
        const existing = this._live.get(sessionId) || await this.get(sessionId);
        if (!existing) return null;
        existing.entries.forEach(e => { e.revealed = Boolean(revealed); });
        existing.updatedAt = now();
        if (this._live.has(sessionId)) this._live.set(sessionId, existing);
        await putRecord(STORE, this._snapshot(existing));
        return this._readonly(existing);
    }

    // ─── Export / reopen ──────────────────────────────────────────────────

    exportMarkdown(session) {
        const blind = session.blind;
        const entries = (session.entries || []).map((e, i) => {
            const label = blind && !e.revealed ? String.fromCharCode(65 + i) : `${e.provider}/${e.model}`;
            const rating = e.rating ? ` · ★ ${e.rating}/5` : '';
            const note = e.ratingNote ? `\n\n_Rating note:_ ${e.ratingNote}` : '';
            return `## Response ${label} — ${e.status}${rating}\n\n${e.content || '_No content._'}${note}`;
        }).join('\n\n---\n\n');

        const synth = session.synthesis?.content
            ? `## Committee Synthesis (${session.synthesis.status})\n\n${session.synthesis.content}`
            : '';

        return [
            `# ${session.title}`,
            ``,
            `- Mode: ${session.mode}`,
            `- Blind: ${session.blind ? 'yes' : 'no'}`,
            `- Status: ${session.status}`,
            `- Temperature: ${session.temperature}`,
            `- Created: ${session.createdAt}`,
            ``,
            `## Prompt`,
            ``,
            session.prompt || '_No prompt._',
            ``,
            session.systemPrompt ? `### System prompt\n\n${session.systemPrompt}\n\n` : '',
            entries,
            synth ? `\n\n---\n\n${synth}` : ''
        ].join('\n');
    }

    exportBlob(session, format = 'markdown') {
        if (format === 'json') {
            return {
                blob: new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }),
                filename: `${slug(session.title)}.json`
            };
        }
        return {
            blob: new Blob([this.exportMarkdown(session)], { type: 'text/markdown' }),
            filename: `${slug(session.title)}.md`
        };
    }

    /**
     * Build a prompt that reopens this comparison as a normal chat,
     * carrying the prompt, each response, and the synthesis as context.
     */
    makeReopenPrompt(session) {
        const responses = (session.entries || []).map((e, i) => {
            const label = String.fromCharCode(65 + i);
            return `**${label} (${e.provider}/${e.model})** — ${e.status}\n${e.content || '_No content._'}`;
        }).join('\n\n');
        return [
            `Continuing from a saved multi-model comparison ("${session.title}").`,
            ``,
            `Original prompt:`,
            session.prompt,
            ``,
            `Model responses:`,
            responses,
            ``,
            session.synthesis?.content ? `Prior committee synthesis:\n${session.synthesis.content}\n\n` : '',
            `Help me go deeper: refine the question, probe where the models disagreed, or draft a follow-up.`
        ].join('\n');
    }

    // ─── Persistence helpers ──────────────────────────────────────────────

    /** @private shallow + entry clone suitable for IDB (no live references). */
    _snapshot(session) {
        return {
            ...session,
            entries: (session.entries || []).map(e => ({ ...e })),
            synthesis: { ...(session.synthesis || {}) }
        };
    }

    /** Coalesce rapid writes; always snapshots the latest live state at flush time. @private */
    _persist(sessionId) {
        const live = this._live.get(sessionId);
        if (!live) return;
        live.updatedAt = now();
        if (this._persistPending.has(sessionId)) return;
        this._persistPending.add(sessionId);
        queueMicrotask(() => {
            this._persistPending.delete(sessionId);
            const current = this._live.get(sessionId);
            if (!current) return;
            putRecord(STORE, this._snapshot(current)).catch(
                e => console.error('[CompareService] persist failed:', e)
            );
        });
    }

    /** Persist either a live or detached session immediately. @private */
    async _persistNow(sessionId, session) {
        session.updatedAt = now();
        if (this._live.has(sessionId)) this._live.set(sessionId, session);
        await putRecord(STORE, this._snapshot(session));
    }

    /** @private */
    _readonlyEntry(entry) {
        return entry ? { ...entry, stats: entry.stats ? { ...entry.stats } : null } : null;
    }

    /** @private */
    _readonly(session) {
        if (!session) return null;
        return {
            ...session,
            entries: (session.entries || []).map(e => this._readonlyEntry(e)),
            synthesis: session.synthesis ? { ...session.synthesis } : null
        };
    }
}

export const compareService = new CompareService();
export { MODES, ENTRY_STATUSES, SESSION_STATUSES, SYNTH_STATUSES };

/**
 * AgentRunService - Defines and persists long-running agent execution state.
 *
 * A run stores the current snapshot used by future UI surfaces, while
 * agentRunEvents keeps a chronological event log for timeline playback.
 */

import { storageService } from './storageService.js';
import { eventBus, Events } from '../utils/eventBus.js';

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function now() {
    return new Date().toISOString();
}

function cloneValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeRunStatus(status = 'pending') {
    const allowed = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);
    return allowed.has(status) ? status : 'pending';
}

function normalizeStepStatus(status = 'pending') {
    const allowed = new Set(['pending', 'running', 'completed', 'failed']);
    return allowed.has(status) ? status : 'pending';
}

function normalizeToolStatus(status = 'pending') {
    const allowed = new Set(['pending', 'running', 'completed', 'failed']);
    return allowed.has(status) ? status : 'pending';
}

function createRunEvent(run, type, payload = {}, timestamp = now()) {
    return {
        id: generateId(),
        runId: run.id,
        chatId: run.chatId || null,
        type,
        payload: cloneValue(payload) || {},
        timestamp
    };
}

function normalizeToolCall(toolCall = {}, timestamp = now()) {
    return {
        id: toolCall.id || generateId(),
        toolName: toolCall.toolName || toolCall.name || 'unknown-tool',
        input: cloneValue(toolCall.input) ?? null,
        output: cloneValue(toolCall.output) ?? null,
        status: normalizeToolStatus(toolCall.status),
        error: toolCall.error ? String(toolCall.error) : null,
        startedAt: toolCall.startedAt || timestamp,
        finishedAt: toolCall.finishedAt || null
    };
}

function normalizeStep(step = {}, timestamp = now()) {
    return {
        id: step.id || generateId(),
        title: step.title || step.label || 'Untitled step',
        status: normalizeStepStatus(step.status),
        output: step.output ? String(step.output) : '',
        error: step.error ? String(step.error) : null,
        startedAt: step.startedAt || timestamp,
        finishedAt: step.finishedAt || null,
        toolCalls: Array.isArray(step.toolCalls)
            ? step.toolCalls.map(call => normalizeToolCall(call, timestamp))
            : []
    };
}

function normalizeRun(run = {}) {
    const createdAt = run.createdAt || now();
    return {
        id: run.id || generateId(),
        chatId: run.chatId || null,
        title: run.title || null,
        objective: String(run.objective || '').trim(),
        status: normalizeRunStatus(run.status),
        summary: run.summary ? String(run.summary) : '',
        output: run.output ? String(run.output) : '',
        error: run.error ? String(run.error) : null,
        createdAt,
        startedAt: run.startedAt || null,
        finishedAt: run.finishedAt || null,
        updatedAt: run.updatedAt || createdAt,
        steps: Array.isArray(run.steps)
            ? run.steps.map(step => normalizeStep(step, run.startedAt || createdAt))
            : []
    };
}

class AgentRunService {
    constructor() {
        this.runs = {};
    }

    async load() {
        const runs = await storageService.loadAgentRuns();
        this.runs = {};
        for (const run of runs) {
            this.runs[run.id] = normalizeRun(run);
        }
    }

    getRun(runId) {
        return runId ? this.runs[runId] || null : null;
    }

    getRunsForChat(chatId) {
        return Object.values(this.runs)
            .filter(run => run.chatId === chatId)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    getAllRuns() {
        return Object.values(this.runs)
            .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    async getRunTimeline(runId) {
        return storageService.loadAgentRunEvents(runId);
    }

    async createRun(input = {}) {
        const timestamp = now();
        const status = normalizeRunStatus(input.status);
        const run = normalizeRun({
            ...input,
            status,
            createdAt: timestamp,
            startedAt: input.startedAt !== undefined
                ? input.startedAt
                : (status !== 'pending' ? timestamp : undefined),
            updatedAt: timestamp
        });

        this.runs[run.id] = run;
        await storageService.saveAgentRun(run);
        const event = createRunEvent(run, 'run-created', {
            objective: run.objective,
            status: run.status
        }, timestamp);
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_CREATED, { run: cloneValue(run) });
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId: run.id, event });
        return cloneValue(run);
    }

    async updateRun(runId, patch = {}) {
        const current = this.getRun(runId);
        if (!current) throw new Error(`Agent run not found: ${runId}`);

        const next = normalizeRun({
            ...current,
            ...cloneValue(patch),
            id: current.id,
            chatId: current.chatId,
            createdAt: current.createdAt,
            updatedAt: now()
        });

        this.runs[runId] = next;
        await storageService.saveAgentRun(next);
        eventBus.emit(Events.AGENT_RUN_UPDATED, { run: cloneValue(next) });
        return cloneValue(next);
    }

    async setRunStatus(runId, status, details = {}) {
        const timestamp = now();
        const current = this.getRun(runId);
        if (!current) throw new Error(`Agent run not found: ${runId}`);

        const patch = {
            status,
            finishedAt: ['completed', 'failed', 'cancelled'].includes(status)
                ? (details.finishedAt || timestamp)
                : null,
            summary: details.summary,
            output: details.output,
            error: details.error
        };
        // Set startedAt when transitioning to running for the first time
        if (status === 'running' && !current.startedAt) {
            patch.startedAt = details.startedAt || timestamp;
        }

        const run = await this.updateRun(runId, patch);

        const event = createRunEvent(run, 'status-changed', {
            status: run.status,
            summary: run.summary,
            error: run.error
        }, timestamp);
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return run;
    }

    async addStep(runId, stepInput = {}) {
        const timestamp = now();
        const run = this.getRun(runId);
        if (!run) throw new Error(`Agent run not found: ${runId}`);

        const step = normalizeStep(stepInput, timestamp);
        const nextSteps = [...run.steps, step];
        const updatedRun = await this.updateRun(runId, { steps: nextSteps });
        const event = createRunEvent(updatedRun, 'step-added', step, timestamp);
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return cloneValue(step);
    }

    async updateStep(runId, stepId, patch = {}) {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Agent run not found: ${runId}`);

        const timestamp = now();
        const nextSteps = run.steps.map(step => {
            if (step.id !== stepId) return step;
            return normalizeStep({
                ...step,
                ...cloneValue(patch),
                id: step.id,
                startedAt: step.startedAt
            }, step.startedAt || timestamp);
        });

        const updatedRun = await this.updateRun(runId, { steps: nextSteps });
        const updatedStep = updatedRun.steps.find(step => step.id === stepId);
        if (!updatedStep) throw new Error(`Agent step not found: ${stepId}`);
        const event = createRunEvent(updatedRun, 'step-updated', updatedStep, timestamp);
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return cloneValue(updatedStep);
    }

    async addToolCall(runId, stepId, toolCallInput = {}) {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Agent run not found: ${runId}`);

        const step = run.steps.find(entry => entry.id === stepId);
        if (!step) throw new Error(`Agent step not found: ${stepId}`);

        const toolCall = normalizeToolCall(toolCallInput);
        const toolCalls = [...step.toolCalls, toolCall];
        await this.updateStep(runId, stepId, { toolCalls });

        const event = createRunEvent(this.getRun(runId), 'tool-call-recorded', {
            stepId,
            toolCall
        }, toolCall.startedAt);
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return cloneValue(toolCall);
    }

    async appendOutput(runId, outputChunk) {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Agent run not found: ${runId}`);

        const nextOutput = [run.output, outputChunk].filter(Boolean).join('');
        const updatedRun = await this.updateRun(runId, { output: nextOutput });
        const event = createRunEvent(updatedRun, 'output-appended', {
            chunk: String(outputChunk || '')
        });
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return cloneValue(updatedRun);
    }

    async recordError(runId, error, details = {}) {
        const message = error instanceof Error ? error.message : String(error);
        const updatedRun = await this.updateRun(runId, {
            error: message,
            status: details.status || 'failed',
            finishedAt: details.finishedAt || now()
        });
        const event = createRunEvent(updatedRun, 'error-recorded', {
            message,
            details: cloneValue(details)
        });
        await storageService.saveAgentRunEvent(event);
        eventBus.emit(Events.AGENT_RUN_EVENT_RECORDED, { runId, event });
        return cloneValue(updatedRun);
    }

    async deleteRun(runId) {
        if (!this.runs[runId]) return;
        delete this.runs[runId];
        await storageService.deleteAgentRun(runId);
        eventBus.emit(Events.AGENT_RUN_DELETED, { runId });
    }

    /**
     * Remove all in-memory runs for a chat. IDB cleanup is already
     * handled by storageService.deleteChat / clearChats.
     * @param {string} chatId
     */
    deleteRunsForChat(chatId) {
        const runs = this.getRunsForChat(chatId);
        for (const run of runs) {
            delete this.runs[run.id];
            eventBus.emit(Events.AGENT_RUN_DELETED, { runId: run.id });
        }
    }

    /**
     * Clear the entire in-memory run cache.
     * IDB cleanup is already handled by storageService.clearChats / clearAll.
     */
    clearRuns() {
        this.runs = {};
    }
}

export const agentRunService = new AgentRunService();

// Keep in-memory cache in sync when chats are deleted via chatService.
eventBus.on(Events.CHAT_DELETED, ({ id, all }) => {
    if (all) {
        agentRunService.clearRuns();
    } else if (id) {
        agentRunService.deleteRunsForChat(id);
    }
});

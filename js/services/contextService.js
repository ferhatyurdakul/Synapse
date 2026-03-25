/**
 * ContextService - Manages context window optimization
 * Uses actual token counts from Ollama to decide when to summarize.
 * Summarization always runs in the background — never blocks a response.
 */

import { providerManager } from './providerManager.js?v=35';
import { storageService } from './storageService.js?v=35';

// Summarize when token usage exceeds this fraction of max context
const SUMMARIZE_THRESHOLD = 0.7;

// Keep the last N messages verbatim after the summary (2 exchanges = 4 messages)
const KEEP_RECENT_COUNT = 4;

const SUMMARIZE_PROMPT = `Summarize the following conversation concisely. Preserve:
- Key facts, decisions, and conclusions
- Code snippets and technical details
- Specific names, numbers, and values
- The overall topic and direction of the conversation

Be thorough but brief. Write in a neutral tone as a factual summary. Output only the summary, no commentary.`;

const EXTEND_SUMMARY_PROMPT = `You have a summary of a conversation and new messages that followed it. Produce a single updated summary that incorporates everything. Preserve all important facts, decisions, code, and context from both. Output only the updated summary, no commentary.`;

class ContextService {
    constructor() {
        // AbortController for any in-progress background summarization
        this._backgroundController = null;
        this.defaultModel = 'gemma3:1b';
    }

    getSummarizationProvider() {
        const settings = storageService.loadSettings();
        return settings.summarizationProvider || 'ollama';
    }

    setSummarizationProvider(provider) {
        const settings = storageService.loadSettings();
        settings.summarizationProvider = provider;
        storageService.saveSettings(settings);
    }

    getSummarizationModel() {
        const settings = storageService.loadSettings();
        return settings.summarizationModel || this.defaultModel;
    }

    setSummarizationModel(model) {
        const settings = storageService.loadSettings();
        settings.summarizationModel = model;
        storageService.saveSettings(settings);
    }

    /**
     * Check if summarization is needed based on actual token usage
     * @param {Object} chat
     * @param {number} maxCtx
     * @returns {boolean}
     */
    shouldSummarize(chat, maxCtx) {
        if (chat.messages.length <= KEEP_RECENT_COUNT) return false;
        const lastUsed = chat.lastTokenCount || 0;
        if (lastUsed === 0) return false;
        return lastUsed > maxCtx * SUMMARIZE_THRESHOLD;
    }

    /**
     * Prepare messages for the API.
     * Uses an existing cached summary if available — never generates one.
     * @param {Object} chat
     * @param {number} maxCtx
     * @param {string} [systemPrompt] - Optional system prompt to prepend
     * @returns {{ messages: Array, summarized: boolean }}
     */
    async prepareMessages(chat, maxCtx, systemPrompt = '') {
        const sysMessages = systemPrompt
            ? [{ role: 'system', content: systemPrompt }]
            : [];

        const messages = chat.messages.map(msg => {
            // Tool messages are stored with role:'tool' but sent to the API as user messages
            if (msg.role === 'tool') {
                return {
                    role: 'user',
                    content: `[Tool: ${msg.toolName}]\n${msg.input}\n→ ${msg.content.replace(/\*\*/g, '')}`,
                };
            }
            const mapped = { role: msg.role, content: msg.content };
            if (msg.images && msg.images.length > 0) mapped.images = msg.images;
            return mapped;
        });

        // Use existing cached summary if it covers at least some history
        if (chat.summary && chat.summarizedUpTo > 0) {
            const recentMessages = messages.slice(chat.summarizedUpTo);
            const summaryMessage = {
                role: 'system',
                content: `Previous conversation summary:\n${chat.summary}`
            };
            return {
                messages: [...sysMessages, summaryMessage, ...recentMessages],
                summarized: true
            };
        }

        // No summary yet — send all messages as-is
        return { messages: [...sysMessages, ...messages], summarized: false };
    }

    /**
     * Run summarization in the background after a response completes.
     * Aborts any previous in-progress summarization for this session.
     * @param {Object} chat - Full chat object (snapshot at call time)
     * @param {number} maxCtx
     * @returns {Promise<{ summary: string, summarizedUpTo: number } | null>}
     */
    async summarizeInBackground(chat, maxCtx) {
        if (!this.shouldSummarize(chat, maxCtx)) return null;

        const splitIndex = chat.messages.length - KEEP_RECENT_COUNT;

        // Already have a summary that covers this range
        if (chat.summary && chat.summarizedUpTo >= splitIndex) return null;

        // Cancel any previous background summarization
        if (this._backgroundController) {
            this._backgroundController.abort();
        }
        this._backgroundController = new AbortController();
        const signal = this._backgroundController.signal;

        const messages = chat.messages.map(msg => ({
            role: msg.role,
            content: msg.content,
            images: msg.images
        }));

        // If a previous summary exists, only process the new messages since then
        const previousSummary = (chat.summary && chat.summarizedUpTo > 0) ? chat.summary : null;
        const startIndex = previousSummary ? chat.summarizedUpTo : 0;
        const messagesToSummarize = messages.slice(startIndex, splitIndex);

        try {
            const summary = await this._summarize(messagesToSummarize, signal, previousSummary);
            this._backgroundController = null;
            return { summary, summarizedUpTo: splitIndex };
        } catch (error) {
            this._backgroundController = null;
            if (error.name === 'AbortError') return null;
            throw error;
        }
    }

    /**
     * @private
     */
    async _summarize(messages, signal, previousSummary = null) {
        const settings = storageService.loadSettings();
        const model = settings.summarizationModel || this.defaultModel;
        const providerName = settings.summarizationProvider || 'ollama';
        const provider = providerManager.getProviderByName(providerName) || providerManager.getProvider();

        // Use the summarization model's actual context length so we never truncate
        let numCtx = 8192; // safe fallback
        try {
            const info = await provider.getModelInfo(model);
            if (info.contextLength > 0) numCtx = info.contextLength;
        } catch {
            // keep fallback
        }

        const conversationText = messages.map(msg => {
            const prefix = msg.role === 'user' ? 'User' : 'Assistant';
            const imageNote = msg.images?.length ? ` [${msg.images.length} image(s) attached]` : '';
            return `${prefix}: ${msg.content}${imageNote}`;
        }).join('\n\n');

        const chatMessages = previousSummary
            ? [
                { role: 'system', content: EXTEND_SUMMARY_PROMPT },
                { role: 'user', content: `Previous summary:\n${previousSummary}\n\nNew messages:\n${conversationText}` }
              ]
            : [
                { role: 'system', content: SUMMARIZE_PROMPT },
                { role: 'user', content: conversationText }
              ];

        const result = await provider.chat(
            model,
            chatMessages,
            () => {},
            { options: { temperature: 0.3, num_ctx: numCtx }, signal }
        );

        return result.content.trim();
    }
}

export const contextService = new ContextService();

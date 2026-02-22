/**
 * ContextService - Manages context window optimization
 * Automatically summarizes older messages when context usage is high
 */

import { ollamaService } from './ollamaService.js?v=24';

// Rough estimate: ~4 characters per token (covers most models)
const CHARS_PER_TOKEN = 4;

// Summarize when usage exceeds this fraction of max context
const SUMMARIZE_THRESHOLD = 0.7;

// Keep the last N messages verbatim (2 exchanges = 4 messages)
const KEEP_RECENT_COUNT = 4;

const SUMMARIZE_PROMPT = `Summarize the following conversation concisely. Preserve:
- Key facts, decisions, and conclusions
- Code snippets and technical details
- Specific names, numbers, and values
- The overall topic and direction of the conversation

Be thorough but brief. Write in a neutral tone as a factual summary.`;

class ContextService {
    /**
     * Estimate token count from text
     * @param {string} text
     * @returns {number}
     */
    estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    /**
     * Estimate total tokens for an array of messages
     * @param {Array<{role: string, content: string}>} messages
     * @returns {number}
     */
    estimateMessagesTokens(messages) {
        let total = 0;
        for (const msg of messages) {
            // Add overhead per message (role, formatting ~4 tokens)
            total += 4;
            total += this.estimateTokens(msg.content);
        }
        return total;
    }

    /**
     * Check if messages need summarization
     * @param {Array} messages
     * @param {number} maxCtx - Maximum context length
     * @returns {boolean}
     */
    shouldSummarize(messages, maxCtx) {
        if (messages.length <= KEEP_RECENT_COUNT) return false;
        const estimated = this.estimateMessagesTokens(messages);
        return estimated > maxCtx * SUMMARIZE_THRESHOLD;
    }

    /**
     * Prepare messages for API, applying summarization if needed
     * @param {Object} chat - Full chat object with messages, summary, summarizedUpTo
     * @param {number} maxCtx - Maximum context length
     * @returns {Promise<{messages: Array, summarized: boolean, summary: string|null, summarizedUpTo: number}>}
     */
    async prepareMessages(chat, maxCtx) {
        const messages = chat.messages.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // Not enough messages or under threshold — send as-is
        if (!this.shouldSummarize(messages, maxCtx)) {
            return {
                messages,
                summarized: false,
                summary: chat.summary || null,
                summarizedUpTo: chat.summarizedUpTo || 0
            };
        }

        // Determine split point: keep last KEEP_RECENT_COUNT messages
        const splitIndex = messages.length - KEEP_RECENT_COUNT;

        // Check if we already have a valid summary covering these messages
        if (chat.summary && chat.summarizedUpTo >= splitIndex) {
            // Reuse existing summary
            const recentMessages = messages.slice(chat.summarizedUpTo);
            const summaryMessage = {
                role: 'system',
                content: `Previous conversation summary:\n${chat.summary}`
            };
            return {
                messages: [summaryMessage, ...recentMessages],
                summarized: true,
                summary: chat.summary,
                summarizedUpTo: chat.summarizedUpTo
            };
        }

        // Need to generate a new summary
        const messagesToSummarize = messages.slice(0, splitIndex);
        const recentMessages = messages.slice(splitIndex);

        try {
            const summary = await this.summarizeMessages(messagesToSummarize, chat.model);
            const summaryMessage = {
                role: 'system',
                content: `Previous conversation summary:\n${summary}`
            };

            return {
                messages: [summaryMessage, ...recentMessages],
                summarized: true,
                summary,
                summarizedUpTo: splitIndex
            };
        } catch (error) {
            console.error('Summarization failed, sending all messages:', error);
            // Fallback: send all messages and let Ollama's sliding window handle it
            return {
                messages,
                summarized: false,
                summary: chat.summary || null,
                summarizedUpTo: chat.summarizedUpTo || 0
            };
        }
    }

    /**
     * Summarize a set of messages using the model
     * @param {Array<{role: string, content: string}>} messages
     * @param {string} model
     * @returns {Promise<string>} Summary text
     */
    async summarizeMessages(messages, model) {
        // Format messages into readable text
        const conversationText = messages.map(msg => {
            const prefix = msg.role === 'user' ? 'User' : 'Assistant';
            return `${prefix}: ${msg.content}`;
        }).join('\n\n');

        const result = await ollamaService.chat(
            model,
            [
                { role: 'system', content: SUMMARIZE_PROMPT },
                { role: 'user', content: conversationText }
            ],
            () => { }, // No streaming needed for summary
            { options: { temperature: 0.3, num_ctx: 4096 } }
        );

        return result.content.trim();
    }
}

export const contextService = new ContextService();

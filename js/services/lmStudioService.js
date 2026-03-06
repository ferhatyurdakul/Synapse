/**
 * LMStudioService - Handles communication with LM Studio's OpenAI-compatible API
 * Supports model listing, chat streaming, and server availability checks
 */

const LMSTUDIO_BASE_URL = 'http://localhost:1234';

class LMStudioService {
    constructor(baseUrl = LMSTUDIO_BASE_URL) {
        this.baseUrl = baseUrl;
        this.abortController = null;
    }

    /**
     * Fetch list of available models from LM Studio
     * @returns {Promise<Array<{name: string, size: number}>>}
     */
    async listModels() {
        const response = await fetch(`${this.baseUrl}/v1/models`);
        if (!response.ok) throw new Error('Failed to fetch LM Studio models');

        const data = await response.json();
        return (data.data || []).map(model => ({
            name: model.id,
            size: 0 // LM Studio doesn't expose model size
        }));
    }

    /**
     * Get model info (limited for LM Studio)
     * @param {string} modelName
     * @returns {Promise<{contextLength: number}>}
     */
    async getModelInfo(modelName) {
        // LM Studio doesn't expose context length via API
        // Return a reasonable default
        return { contextLength: 8192 };
    }

    /**
     * Send a chat message with streaming response
     * @param {string} model - Model name
     * @param {Array<{role: string, content: string}>} messages - Chat history
     * @param {Function} onChunk - Callback for each streamed chunk
     * @param {Object} options - Additional options
     * @returns {Promise<{content: string, thinking: string, promptEvalCount: number, evalCount: number, evalDuration: number, promptEvalDuration: number, totalDuration: number, doneReason: string}>}
     */
    async chat(model, messages, onChunk, options = {}) {
        this.abort();
        this.abortController = new AbortController();

        const requestBody = {
            model,
            messages,
            stream: true
        };

        // Map Ollama-style options to OpenAI-style params
        if (options.options) {
            if (options.options.temperature !== undefined) requestBody.temperature = options.options.temperature;
            if (options.options.top_p !== undefined) requestBody.top_p = options.options.top_p;
            if (options.options.num_ctx !== undefined) requestBody.max_tokens = options.options.num_ctx;
            if (options.options.repeat_penalty !== undefined) requestBody.frequency_penalty = options.options.repeat_penalty - 1; // LM Studio uses -2 to 2 scale
        }

        const startTime = Date.now();
        let firstTokenTime = 0;

        try {
            const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`LM Studio error ${response.status}: ${errText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let promptTokens = 0;
            let completionTokens = 0;
            let finishReason = 'stop';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const json = JSON.parse(data);

                        // Extract content delta
                        const delta = json.choices?.[0]?.delta;
                        if (delta?.content) {
                            if (!firstTokenTime) firstTokenTime = Date.now();
                            fullContent += delta.content;

                            onChunk({
                                content: delta.content,
                                fullContent,
                                thinking: '',
                                fullThinking: '',
                                isThinking: false,
                                done: false
                            });
                        }

                        // Check finish reason
                        if (json.choices?.[0]?.finish_reason) {
                            finishReason = json.choices[0].finish_reason;
                        }

                        // Token usage (usually in the last chunk)
                        if (json.usage) {
                            promptTokens = json.usage.prompt_tokens || 0;
                            completionTokens = json.usage.completion_tokens || 0;
                        }
                    } catch (parseError) {
                        // Skip unparseable chunks
                    }
                }
            }

            this.abortController = null;

            const endTime = Date.now();
            const totalDuration = (endTime - startTime) * 1e6; // Convert ms to ns
            const promptEvalDuration = firstTokenTime ? (firstTokenTime - startTime) * 1e6 : 0;
            const evalDuration = firstTokenTime ? (endTime - firstTokenTime) * 1e6 : totalDuration;

            return {
                content: fullContent,
                thinking: '',
                promptEvalCount: promptTokens,
                evalCount: completionTokens,
                evalDuration,
                promptEvalDuration,
                totalDuration,
                doneReason: finishReason === 'stop' ? 'stop' : finishReason
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('LM Studio chat request aborted');
                return { content: '', thinking: '', promptEvalCount: 0, evalCount: 0, evalDuration: 0, promptEvalDuration: 0, totalDuration: 0, doneReason: '' };
            }
            throw error;
        }
    }

    /**
     * Abort ongoing request
     */
    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    /**
     * Check if LM Studio server is reachable
     * @returns {Promise<boolean>}
     */
    async isServerAvailable() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

export const lmStudioService = new LMStudioService();

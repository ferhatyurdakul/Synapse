/**
 * LMStudioService - Handles communication with LM Studio's OpenAI-compatible API
 * Supports model listing, chat streaming, thinking mode, and server availability checks
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
            size: 0 // LM Studio doesn't expose model size in list
        }));
    }

    /**
     * Get model info including context length from LM Studio
     * @param {string} modelName
     * @returns {Promise<{contextLength: number}>}
     */
    async getModelInfo(modelName) {
        try {
            // LM Studio v1 API exposes model details via GET /v1/models/{id}
            const response = await fetch(`${this.baseUrl}/v1/models/${encodeURIComponent(modelName)}`);
            if (response.ok) {
                const data = await response.json();
                // LM Studio returns max_context_length in model info
                const ctxLen = data.max_context_length || data.context_length || data.max_model_len || 0;
                if (ctxLen > 0) {
                    return { contextLength: ctxLen };
                }
            }
        } catch (e) {
            console.warn('[LMStudio] Could not fetch model info for', modelName, e);
        }

        // Fallback: try the native API endpoint
        try {
            const response = await fetch(`${this.baseUrl}/api/v0/models/${encodeURIComponent(modelName)}`);
            if (response.ok) {
                const data = await response.json();
                const ctxLen = data.max_context_length || data.context_length || 0;
                if (ctxLen > 0) {
                    return { contextLength: ctxLen };
                }
            }
        } catch (e) {
            // Fallback failed
        }

        // Default fallback
        return { contextLength: 32768 };
    }

    /**
     * Send a chat message with streaming response
     * Handles thinking mode via <think> tags and token usage via stream_options
     */
    async chat(model, messages, onChunk, options = {}) {
        this.abort();
        this.abortController = new AbortController();

        const requestBody = {
            model,
            messages,
            stream: true,
            // Request token usage in the final SSE chunk
            stream_options: { include_usage: true }
        };

        // Map Ollama-style options to OpenAI-style params
        if (options.options) {
            if (options.options.temperature !== undefined) requestBody.temperature = options.options.temperature;
            if (options.options.top_p !== undefined) requestBody.top_p = options.options.top_p;
            if (options.options.num_ctx !== undefined) requestBody.max_tokens = options.options.num_ctx;
            if (options.options.repeat_penalty !== undefined) {
                requestBody.frequency_penalty = Math.max(-2, Math.min(2, options.options.repeat_penalty - 1));
            }
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
            let rawContent = '';       // Raw content including <think> tags
            let fullContent = '';      // Content without thinking
            let fullThinking = '';     // Thinking content only
            let isInThinking = false;  // Currently inside <think> block
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
                            rawContent += delta.content;

                            // Parse thinking blocks from the content
                            const parsed = this.processStreamChunk(delta.content, isInThinking);
                            isInThinking = parsed.isInThinking;

                            if (parsed.thinkingContent) {
                                fullThinking += parsed.thinkingContent;
                            }
                            if (parsed.regularContent) {
                                fullContent += parsed.regularContent;
                            }

                            onChunk({
                                content: parsed.regularContent,
                                fullContent,
                                thinking: parsed.thinkingContent,
                                fullThinking,
                                isThinking: isInThinking,
                                done: false
                            });
                        }

                        // Check finish reason
                        if (json.choices?.[0]?.finish_reason) {
                            finishReason = json.choices[0].finish_reason;
                        }

                        // Token usage (in the final chunk when stream_options.include_usage is true)
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
            const totalDuration = (endTime - startTime) * 1e6; // Convert ms to ns (match Ollama format)
            const promptEvalDuration = firstTokenTime ? (firstTokenTime - startTime) * 1e6 : 0;
            const evalDuration = firstTokenTime ? (endTime - firstTokenTime) * 1e6 : totalDuration;

            return {
                content: fullContent,
                thinking: fullThinking,
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
     * Process a stream chunk to detect and separate <think>...</think> blocks
     * Same logic as OllamaService.processStreamChunk
     * @private
     */
    processStreamChunk(chunk, isInThinking) {
        let regularContent = '';
        let thinkingContent = '';
        let currentInThinking = isInThinking;

        let remaining = chunk;

        while (remaining.length > 0) {
            if (currentInThinking) {
                const closeIndex = remaining.indexOf('</think>');
                if (closeIndex !== -1) {
                    thinkingContent += remaining.substring(0, closeIndex);
                    remaining = remaining.substring(closeIndex + 8);
                    currentInThinking = false;
                } else {
                    thinkingContent += remaining;
                    remaining = '';
                }
            } else {
                const openIndex = remaining.indexOf('<think>');
                if (openIndex !== -1) {
                    regularContent += remaining.substring(0, openIndex);
                    remaining = remaining.substring(openIndex + 7);
                    currentInThinking = true;
                } else {
                    regularContent += remaining;
                    remaining = '';
                }
            }
        }

        return {
            regularContent,
            thinkingContent,
            isInThinking: currentInThinking
        };
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

/**
 * LMStudioService - Handles communication with LM Studio's OpenAI-compatible API
 * Supports model listing, chat streaming, thinking mode, and server availability checks
 */

const LMSTUDIO_BASE_URL = 'http://localhost:1234';

class LMStudioService {
    constructor(baseUrl = LMSTUDIO_BASE_URL) {
        this.baseUrl = baseUrl;
        this.defaultUrl = LMSTUDIO_BASE_URL;
        this.abortController = null;
        /** @type {Map<string, {state: string, type: string, maxContextLength: number}>} */
        this.modelCache = new Map();
        this.hasV0Api = null; // null = unknown, true/false after first attempt
        // Cache for models that don't support tool calling
        this.noToolsModels = new Set();
    }

    /**
     * Fetch list of available models from LM Studio
     * Prefers /api/v0/models for rich data (state, type), falls back to /v1/models
     * Filters out embedding models
     * @returns {Promise<Array<{name: string, size: number, state: string, type: string, maxContextLength: number}>>}
     */
    async listModels() {
        // Try v0 API first (unless we already know it's unavailable)
        if (this.hasV0Api !== false) {
            try {
                const response = await fetch(`${this.baseUrl}/api/v0/models`);
                if (response.ok) {
                    this.hasV0Api = true;
                    const data = await response.json();
                    const models = (data.data || data || [])
                        .filter(model => model.type !== 'embeddings')
                        .map(model => ({
                            name: model.id,
                            size: 0,
                            state: model.state || 'not-loaded',
                            type: model.type || 'llm',
                            maxContextLength: model.max_context_length || 0
                        }));

                    // Cache model data for getModelInfo
                    this.modelCache.clear();
                    models.forEach(m => this.modelCache.set(m.name, m));

                    return models;
                }
            } catch (e) {
                // v0 API not available
            }
            this.hasV0Api = false;
        }

        // Fallback to /v1/models
        const response = await fetch(`${this.baseUrl}/v1/models`);
        if (!response.ok) throw new Error('Failed to fetch LM Studio models');

        const data = await response.json();
        return (data.data || []).map(model => ({
            name: model.id,
            size: 0,
            state: 'unknown',
            type: 'llm',
            maxContextLength: 0
        }));
    }

    /**
     * Load a model into LM Studio memory
     * @param {string} modelName - Model identifier
     * @returns {Promise<{status: string, loadTime: number}>}
     */
    async loadModel(modelName, params = {}) {
        const startTime = Date.now();
        const body = { model: modelName };

        // context_length is the only load-time parameter LM Studio accepts
        // (temperature, top_p, etc. are inference-time and sent per-request in chat())
        if (params.num_ctx) body.context_length = params.num_ctx;

        const response = await fetch(`${this.baseUrl}/api/v1/models/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Failed to load model: ${errText}`);
        }

        const loadTime = Date.now() - startTime;

        // Update cache
        const cached = this.modelCache.get(modelName);
        if (cached) cached.state = 'loaded';

        return { status: 'loaded', loadTime };
    }

    /**
     * Check if a model likely supports vision based on name heuristics
     * Used as fallback when v0 API type data is not available
     * @param {string} modelName
     * @returns {boolean}
     */
    modelSupportsVision(modelName) {
        const lower = modelName.toLowerCase();
        const visionKeywords = ['vision', 'llava', 'bakllava', 'moondream', 'minicpm-v', 'cogvlm', 'qwen3.5', 'qwen2.5-vl', 'qwen2-vl'];
        return visionKeywords.some(kw => lower.includes(kw));
    }

    /**
     * Get model info including context length from LM Studio
     * Uses cached v0 API data when available for type-based vision detection
     * @param {string} modelName
     * @returns {Promise<{contextLength: number, supportsVision: boolean}>}
     */
    async getModelInfo(modelName) {
        // Check cached v0 data for type-based vision detection
        const cached = this.modelCache.get(modelName);
        const supportsVisionFromCache = cached?.type === 'vlm';

        try {
            // LM Studio v1 API exposes model details via GET /v1/models/{id}
            const response = await fetch(`${this.baseUrl}/v1/models/${encodeURIComponent(modelName)}`);
            if (response.ok) {
                const data = await response.json();
                const ctxLen = data.max_context_length || data.context_length || data.max_model_len || 0;
                if (ctxLen > 0) {
                    const supportsVision = cached ? supportsVisionFromCache : this.modelSupportsVision(modelName);
                    return { contextLength: ctxLen, supportsVision };
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
                    const supportsVision = data.type === 'vlm' || this.modelSupportsVision(modelName);
                    return { contextLength: ctxLen, supportsVision };
                }
            }
        } catch (e) {
            // Fallback failed
        }

        // Default fallback
        const supportsVision = cached ? supportsVisionFromCache : this.modelSupportsVision(modelName);
        return { contextLength: 32768, supportsVision };
    }

    /**
     * Format messages for OpenAI-compatible API (content-array for images)
     * @param {Array} messages - Messages array
     * @returns {Array} Formatted messages
     */
    formatMessagesWithImages(messages) {
        return messages.map(msg => {
            if (!msg.images || msg.images.length === 0) return msg;
            const content = [
                { type: 'text', text: msg.content }
            ];
            for (const img of msg.images) {
                content.push({
                    type: 'image_url',
                    image_url: { url: img }
                });
            }
            return { role: msg.role, content };
        });
    }

    /**
     * Send a chat message with streaming response
     * Handles thinking mode via <think> tags and token usage via stream_options
     */
    async chat(model, messages, onChunk, options = {}) {
        // If an external signal is provided, use it (for concurrent background streams)
        const externalSignal = options.signal;
        if (!externalSignal) {
            this.abort();
            this.abortController = new AbortController();
        }
        const signal = externalSignal || this.abortController.signal;

        const formattedMessages = this.formatMessagesWithImages(messages);

        const requestBody = {
            model,
            messages: formattedMessages,
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

        // Include function-calling tools if provided and model supports them
        const modelKey = requestBody.model?.toLowerCase() || '';
        if (options.tools && options.tools.length > 0 && !this.noToolsModels.has(modelKey)) {
            requestBody.tools = options.tools;
            requestBody.tool_choice = 'auto';
        }

        const startTime = Date.now();
        let firstTokenTime = 0;

        try {
            const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal
            });

            if (!response.ok && response.status === 400 && requestBody.tools) {
                console.log(`Model ${requestBody.model} doesn't support tool calling, retrying without tools`);
                this.noToolsModels.add(modelKey);
                return this.chat(model, messages, onChunk, options);
            }

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
            /** @type {Array<{id: string, type: string, function: {name: string, arguments: string}}>} */
            let toolCallsAccum = [];

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

                        // Assemble tool_calls from partial SSE deltas
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!toolCallsAccum[idx]) {
                                    toolCallsAccum[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                                }
                                if (tc.id) toolCallsAccum[idx].id = tc.id;
                                if (tc.function?.name) toolCallsAccum[idx].function.name += tc.function.name;
                                if (tc.function?.arguments) toolCallsAccum[idx].function.arguments += tc.function.arguments;
                            }
                        }

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

            if (!externalSignal) this.abortController = null;

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
                doneReason: finishReason === 'stop' ? 'stop' : finishReason,
                toolCalls: toolCallsAccum.length > 0 ? toolCallsAccum : undefined
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

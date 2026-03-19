/**
 * OllamaService - Handles all communication with local Ollama API
 * Supports model listing, chat, and streaming responses
 */

const OLLAMA_BASE_URL = 'http://localhost:11434';

class OllamaService {
    constructor(baseUrl = OLLAMA_BASE_URL) {
        this.baseUrl = baseUrl;
        this.defaultUrl = OLLAMA_BASE_URL;
        this.abortController = null;
        // Cache for models that don't support thinking mode
        this.noThinkingModels = new Set();
        // Cache for models that don't support tool calling
        this.noToolsModels = new Set();
        // Known models that support thinking mode
        this.knownThinkingModels = ['qwen3', 'qwq', 'deepseek-r1'];
    }

    /**
     * Check if a model supports thinking mode
     * @param {string} model - Model name
     * @returns {boolean}
     */
    modelSupportsThinking(model) {
        const modelLower = model.toLowerCase();

        // If we've already determined it doesn't support thinking, return false
        if (this.noThinkingModels.has(modelLower)) {
            return false;
        }

        // Check if it's a known thinking model
        return this.knownThinkingModels.some(known => modelLower.includes(known));
    }

    /**
     * Mark a model as not supporting thinking mode
     * @param {string} model - Model name
     */
    markModelNoThinking(model) {
        this.noThinkingModels.add(model.toLowerCase());
    }

    /**
     * Fetch list of locally available models
     * @returns {Promise<Array<{name: string, size: number, modifiedAt: string}>>}
     */
    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);

            if (!response.ok) {
                throw new Error(`Failed to fetch models: ${response.statusText}`);
            }

            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error('Error fetching models:', error);
            throw error;
        }
    }

    /**
     * Get detailed info about a specific model
     * @param {string} modelName - Name of the model
     * @returns {Promise<{modelfile: string, parameters: string, details: object, contextLength: number}>}
     */
    async getModelInfo(modelName) {
        try {
            const response = await fetch(`${this.baseUrl}/api/show`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: modelName })
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch model info: ${response.statusText}`);
            }

            const data = await response.json();

            // Extract context length from model_info (preferred) or parameters string
            let contextLength = 131072; // fallback to max if not found

            // Check model_info first - context_length is stored with architecture prefix
            // e.g., "gemma3.context_length", "qwen3.context_length", "llama.context_length"
            if (data.model_info) {
                for (const key of Object.keys(data.model_info)) {
                    if (key.endsWith('.context_length')) {
                        contextLength = data.model_info[key];
                        break;
                    }
                }
            }

            // Fallback: check parameters string for num_ctx override
            if (data.parameters) {
                const match = data.parameters.match(/num_ctx\s+(\d+)/);
                if (match) {
                    contextLength = parseInt(match[1]);
                }
            }

            // Detect vision capability:
            // 1. Check families array for "clip" (LLaVA-style models)
            // 2. Check model_info keys for vision/image entries (Qwen 3.5, etc.)
            const families = data.details?.families || [];
            let supportsVision = families.some(f => f.toLowerCase() === 'clip');

            if (!supportsVision && data.model_info) {
                supportsVision = Object.keys(data.model_info).some(k =>
                    k.includes('.vision.') || k.endsWith('.image_token_id')
                );
            }

            return {
                ...data,
                contextLength,
                supportsVision
            };
        } catch (error) {
            console.error('Error fetching model info:', error);
            return { contextLength: 131072, supportsVision: false }; // Return max on error
        }
    }

    /**
     * Format messages for Ollama API, converting image data URLs to raw base64
     * @param {Array} messages - Messages array
     * @returns {Array} Formatted messages
     */
    formatMessagesWithImages(messages) {
        return messages.map(msg => {
            if (!msg.images || msg.images.length === 0) return msg;
            return {
                role: msg.role,
                content: msg.content,
                images: msg.images.map(img => {
                    // Strip data URL prefix if present (Ollama expects raw base64)
                    const base64Match = img.match(/^data:image\/[^;]+;base64,(.+)$/);
                    return base64Match ? base64Match[1] : img;
                })
            };
        });
    }

    /**
     * Send a chat message and receive streaming response
     * @param {string} model - Model name to use
     * @param {Array<{role: string, content: string}>} messages - Chat history
     * @param {Function} onChunk - Callback for each streamed chunk
     * @param {Object} options - Additional options (temperature, etc.)
     * @returns {Promise<{content: string, thinking: string}>}
     */
    async chat(model, messages, onChunk, options = {}) {
        // If an external signal is provided, use it (for concurrent background streams)
        const externalSignal = options.signal;
        if (!externalSignal) {
            // Cancel any ongoing request
            this.abort();
            this.abortController = new AbortController();
        }
        const signal = externalSignal || this.abortController.signal;

        // Check if model supports thinking (cached)
        const supportsThinking = this.modelSupportsThinking(model);

        const formattedMessages = this.formatMessagesWithImages(messages);

        const { signal: _sig, ...restOptions } = options;
        const requestBody = {
            model,
            messages: formattedMessages,
            stream: true,
            ...restOptions
        };

        // Strip tools if model is known not to support them
        if (this.noToolsModels.has(model.toLowerCase()) && requestBody.tools) {
            delete requestBody.tools;
        }

        // Add think:true only if model is known to support it AND no tools are provided
        // (tool calling + thinking can conflict in Ollama's template rendering)
        if (supportsThinking && !requestBody.tools) {
            requestBody.think = true;
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal
            });

            if (!response.ok && response.status === 400) {
                // Retry without thinking mode if it was enabled
                if (supportsThinking && requestBody.think) {
                    console.log(`Model ${model} doesn't support thinking mode, retrying without it`);
                    this.markModelNoThinking(model);
                    return this.chat(model, messages, onChunk, options);
                }
                // Retry without tools if they were sent
                if (requestBody.tools) {
                    console.log(`Model ${model} doesn't support tool calling, retrying without tools`);
                    this.noToolsModels.add(model.toLowerCase());
                    return this.chat(model, messages, onChunk, options);
                }
            }

            if (!response.ok) {
                throw new Error(`Chat request failed: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            let fullContent = '';
            let fullThinking = '';
            let buffer = '';
            let inThinkingBlock = false;
            let promptEvalCount = 0;
            let evalCount = 0;
            let evalDuration = 0;
            let promptEvalDuration = 0;
            let totalDuration = 0;
            let doneReason = '';
            let toolCalls = null;

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Process complete JSON lines
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const json = JSON.parse(line);
                        const content = json.message?.content || '';
                        // Ollama returns thinking in a separate field for models like Qwen3
                        const thinkingFromApi = json.message?.thinking || '';

                        // Handle thinking from Ollama API (Qwen3, etc.)
                        if (thinkingFromApi) {
                            fullThinking += thinkingFromApi;
                        }

                        if (content) {
                            // Also try to detect <think> tags in content (DeepSeek style)
                            const {
                                regularContent,
                                thinkingContent,
                                isInThinking
                            } = this.processStreamChunk(
                                content,
                                inThinkingBlock
                            );

                            inThinkingBlock = isInThinking;

                            // Add any thinking found in content tags
                            if (thinkingContent) {
                                fullThinking += thinkingContent;
                            }

                            if (regularContent) {
                                fullContent += regularContent;
                            }

                            // Callback with current state
                            onChunk({
                                content: regularContent,
                                thinking: thinkingContent || thinkingFromApi,
                                fullContent,
                                fullThinking,
                                isThinking: inThinkingBlock || !!thinkingFromApi,
                                done: json.done || false
                            });
                        } else if (thinkingFromApi) {
                            // Only thinking was received (common during Qwen3 thinking phase)
                            onChunk({
                                content: '',
                                thinking: thinkingFromApi,
                                fullContent,
                                fullThinking,
                                isThinking: true,
                                done: json.done || false
                            });
                        }

                        // Capture tool_calls from any chunk (can appear before done)
                        if (json.message?.tool_calls) {
                            toolCalls = json.message.tool_calls;
                        }

                        if (json.done) {
                            promptEvalCount = json.prompt_eval_count || 0;
                            evalCount = json.eval_count || 0;
                            evalDuration = json.eval_duration || 0;
                            promptEvalDuration = json.prompt_eval_duration || 0;
                            totalDuration = json.total_duration || 0;
                            doneReason = json.done_reason || 'stop';
                            if (json.message?.tool_calls) {
                                toolCalls = json.message.tool_calls;
                            }
                            console.debug('[Ollama] done chunk:', { doneReason, toolCalls, content: fullContent?.slice(0, 100) });
                            break;
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse stream chunk:', line);
                    }
                }
            }

            if (!externalSignal) this.abortController = null;

            return {
                content: fullContent,
                thinking: fullThinking,
                promptEvalCount,
                evalCount,
                evalDuration,
                promptEvalDuration,
                totalDuration,
                doneReason,
                toolCalls: toolCalls || undefined
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Chat request aborted');
                return { content: '', thinking: '' };
            }
            console.error('Chat error:', error);
            throw error;
        }
    }

    /**
     * Process a stream chunk to detect and separate thinking blocks
     * @private
     */
    processStreamChunk(chunk, isInThinking) {
        let regularContent = '';
        let thinkingContent = '';
        let currentInThinking = isInThinking;

        let remaining = chunk;

        while (remaining.length > 0) {
            if (currentInThinking) {
                // Look for closing tag
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
                // Look for opening tag
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
     * No-op: Ollama loads models automatically on first use
     * @param {string} modelName
     * @returns {Promise<{status: string, loadTime: number}>}
     */
    async loadModel(modelName) {
        return { status: 'loaded', loadTime: 0 };
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
     * Check if Ollama server is reachable
     * @returns {Promise<boolean>}
     */
    async isServerAvailable() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

// Export singleton instance
export const ollamaService = new OllamaService();

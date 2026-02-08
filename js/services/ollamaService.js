/**
 * OllamaService - Handles all communication with local Ollama API
 * Supports model listing, chat, and streaming responses
 */

const OLLAMA_BASE_URL = 'http://localhost:11434';

class OllamaService {
    constructor(baseUrl = OLLAMA_BASE_URL) {
        this.baseUrl = baseUrl;
        this.abortController = null;
        // Cache for models that don't support thinking mode
        this.noThinkingModels = new Set();
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
     * Send a chat message and receive streaming response
     * @param {string} model - Model name to use
     * @param {Array<{role: string, content: string}>} messages - Chat history
     * @param {Function} onChunk - Callback for each streamed chunk
     * @param {Object} options - Additional options (temperature, etc.)
     * @returns {Promise<{content: string, thinking: string}>}
     */
    async chat(model, messages, onChunk, options = {}) {
        // Cancel any ongoing request
        this.abort();
        this.abortController = new AbortController();

        // Check if model supports thinking (cached)
        const supportsThinking = this.modelSupportsThinking(model);

        const requestBody = {
            model,
            messages,
            stream: true,
            ...options
        };

        // Add think:true only if model is known to support it
        if (supportsThinking) {
            requestBody.think = true;
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });

            // If we get 400 and we tried thinking mode, retry without it
            if (!response.ok && response.status === 400 && supportsThinking) {
                console.log(`Model ${model} doesn't support thinking mode, retrying without it`);
                this.markModelNoThinking(model);
                return this.chat(model, messages, onChunk, options);
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

                        if (json.done) {
                            break;
                        }
                    } catch (parseError) {
                        console.warn('Failed to parse stream chunk:', line);
                    }
                }
            }

            this.abortController = null;

            return {
                content: fullContent,
                thinking: fullThinking
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

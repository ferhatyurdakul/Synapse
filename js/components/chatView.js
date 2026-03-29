/**
 * ChatView - Main chat display component with streaming support
 */

import { chatService } from '../services/chatService.js';
import { contextService } from '../services/contextService.js';
import { storageService } from '../services/storageService.js';
import { providerManager } from '../services/providerManager.js';
import { titleService } from '../services/titleService.js';
import { toolRegistry } from '../services/toolRegistry.js';
import { ragService } from '../services/ragService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { renderMarkdown, renderLatexInElement, escapeHtml } from '../utils/markdown.js';
import { createThinkingBlock, updateThinkingBlock, getDefaultCollapsedState } from './thinkingBlock.js';
import { getModelParams } from './settingsPanel.js';
import { toast } from './toast.js';

const PROMPT_EXAMPLES = [
    { icon: '💡', text: 'Explain quantum computing in simple terms' },
    { icon: '📝', text: 'Write a short poem about the ocean' },
    { icon: '🧮', text: 'Solve this: If a train travels 120km in 2 hours, what is its speed?' },
    { icon: '🌍', text: 'What are the top 5 most visited countries in the world?' },
    { icon: '🍳', text: 'Give me a quick recipe for pasta carbonara' },
    { icon: '🎯', text: 'What are some effective productivity techniques?' },
    { icon: '🧬', text: 'Explain how CRISPR gene editing works' },
    { icon: '🚀', text: 'Compare SpaceX and NASA approaches to space exploration' },
    { icon: '🎨', text: 'Describe the differences between impressionism and expressionism' },
    { icon: '💻', text: 'Explain the difference between REST and GraphQL APIs' },
    { icon: '📊', text: 'What are the pros and cons of remote work?' },
    { icon: '🧠', text: 'How does memory work in the human brain?' },
    { icon: '🎵', text: 'Recommend 5 albums that defined their genre' },
    { icon: '🏗️', text: 'Explain microservices architecture vs monolithic' },
    { icon: '🌱', text: 'What are practical ways to reduce carbon footprint?' }
];

class ChatView {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.currentStreamEl = null;
        this.currentThinkingBlock = null;
        this.selectedModel = null;
        this.activeStreams = new Map(); // chatId -> stream state
        this.webSearchEnabled = false;

        this.init();
    }

    init() {
        this.render();
        this.listenToEvents();
        this.attachScrollTracker();
    }

    render() {
        this.container.innerHTML = `
            <div class="chat-view">
                <div id="messages-container" class="messages-container">
                    ${this.buildWelcomeScreen()}
                </div>
                <button id="scroll-to-bottom" class="scroll-to-bottom-btn" title="Jump to latest message" aria-label="Jump to latest message">
                    <i data-lucide="arrow-down" class="icon"></i>
                </button>
            </div>
        `;
        this.attachPromptClickHandlers();
        document.getElementById('scroll-to-bottom').addEventListener('click', () => {
            this.scrollToBottom(true);
        });
        refreshIcons();
    }

    attachScrollTracker() {
        const container = document.getElementById('messages-container');
        const scrollBtn = document.getElementById('scroll-to-bottom');
        this._userScrolledUp = false;
        this._isProgrammaticScroll = false;

        container.addEventListener('scroll', () => {
            if (this._isProgrammaticScroll) return;
            const threshold = 60;
            const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
            this._userScrolledUp = !atBottom;
            scrollBtn.classList.toggle('visible', !atBottom);
        });
    }

    buildWelcomeScreen() {
        const prompts = this.getRandomPrompts(3);
        return `
            <div class="welcome-message">
                <div class="welcome-icon">⟩_</div>
                <h2>Welcome to Synapse</h2>
                <p>Select a model and try a prompt to get started.</p>
                <div class="welcome-prompts">
                    ${prompts.map(p => `
                        <div class="prompt-card" data-prompt="${p.text.replace(/"/g, '&quot;')}">
                            <span class="prompt-icon">${p.icon}</span>
                            <span class="prompt-text">${p.text}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    getRandomPrompts(count) {
        const shuffled = [...PROMPT_EXAMPLES].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count);
    }

    attachPromptClickHandlers() {
        document.querySelectorAll('.prompt-card').forEach(card => {
            card.addEventListener('click', () => {
                if (!this.selectedModel) return;
                const prompt = card.dataset.prompt;
                eventBus.emit(Events.MESSAGE_SENT, { content: prompt });
            });
        });
    }

    listenToEvents() {
        eventBus.on(Events.MODEL_CHANGED, ({ model }) => {
            this.selectedModel = model;
        });

        eventBus.on(Events.CHAT_SELECTED, ({ chat }) => {
            this.displayChat(chat);
        });

        eventBus.on(Events.CHAT_CREATED, ({ chat }) => {
            this.displayChat(chat);
        });

        eventBus.on(Events.MESSAGE_SENT, async ({ content, images, documents }) => {
            await this.handleUserMessage(content, images, documents);
        });

        eventBus.on(Events.WEB_SEARCH_TOGGLED, ({ enabled }) => {
            this.webSearchEnabled = enabled;
        });


        eventBus.on(Events.STREAM_END, ({ aborted }) => {
            if (aborted) {
                // Only abort the stream for the currently viewed chat
                const currentId = chatService.getCurrentChatId();
                const streamState = this.activeStreams.get(currentId);
                if (streamState && streamState.abortController) {
                    streamState.abortController.abort();
                }
            }
        });

        // Listen for resend message event from global handler
        window.addEventListener('resend-message', async (e) => {
            const chat = chatService.getCurrentChat();
            if (chat && chat.messages.length > 0) {
                const lastMsg = chat.messages[chat.messages.length - 1];
                if (lastMsg.role === 'assistant') {
                    chatService.deleteLastMessage();
                }
            }
            this.displayChat(chatService.getCurrentChat());
            await this.streamResponse();
        });

        // Edit user message
        window.addEventListener('edit-message', (e) => {
            const { index } = e.detail;
            const chat = chatService.getCurrentChat();
            if (!chat || index < 0 || index >= chat.messages.length) return;

            const msgEl = document.querySelector(`.message[data-index="${index}"]`);
            if (!msgEl) return;

            const contentEl = msgEl.querySelector('.message-content');
            const originalContent = chat.messages[index].content;

            msgEl.classList.add('editing');
            contentEl.innerHTML = `
                <textarea class="message-edit-area">${escapeHtml(originalContent)}</textarea>
                <div class="edit-actions">
                    <button class="edit-save-btn" onclick="saveEditMessage(${index})">
                        <i data-lucide="check" class="icon"></i> Save & Submit
                    </button>
                    <button class="edit-cancel-btn" onclick="cancelEditMessage(${index})">
                        <i data-lucide="x" class="icon"></i> Cancel
                    </button>
                </div>
            `;
            refreshIcons();

            // Focus textarea and move cursor to end
            const textarea = contentEl.querySelector('.message-edit-area');
            textarea.focus();
            textarea.selectionStart = textarea.value.length;
        });

        // Save edited message
        window.addEventListener('save-edit-message', async (e) => {
            const { index } = e.detail;
            const chat = chatService.getCurrentChat();
            if (!chat) return;

            const msgEl = document.querySelector(`.message[data-index="${index}"]`);
            if (!msgEl) return;

            const textarea = msgEl.querySelector('.message-edit-area');
            const newContent = textarea.value.trim();
            if (!newContent) return;

            // Auto-branch: create a new branch with the edit, keep original untouched
            const settings = storageService.loadSettings();
            if (settings.branchOnEdit) {
                const lastMsgIndex = chat.messages.length - 1;
                const lastMsgId = chat.messages[lastMsgIndex].id;
                const branchId = await chatService.forkChat(chat.id, lastMsgId);
                chatService.selectChat(branchId);
                const branchChat = chatService.getCurrentChat();

                // Find the same message index in the branch and apply the edit there
                chatService.updateMessage(index, newContent);
                chatService.truncateFromMessage(index + 1);

                this.displayChat(branchChat);

                if (this.endsWithUserMessage(branchChat)) {
                    await this.streamResponse();
                }
                return;
            }

            // Update the message and truncate everything after it
            chatService.updateMessage(index, newContent);
            chatService.truncateFromMessage(index + 1);

            this.displayChat(chat);

            // Only stream if the last remaining message is from the user
            if (this.endsWithUserMessage(chat)) {
                await this.streamResponse();
            }
        });

        // Cancel edit
        window.addEventListener('cancel-edit-message', (e) => {
            const { index } = e.detail;
            // Simply re-render the chat to restore original content
            this.displayChat(chatService.getCurrentChat());
        });

        // Regenerate from here
        window.addEventListener('regenerate-from-here', async (e) => {
            const { index } = e.detail;
            const chat = chatService.getCurrentChat();
            if (!chat) return;

            // Truncate from this assistant message onwards
            chatService.truncateFromMessage(index);

            this.displayChat(chat);

            // Only stream if the last remaining message is from the user
            if (this.endsWithUserMessage(chat)) {
                await this.streamResponse();
            }
        });

        // Branch from here
        window.addEventListener('branch-from-here', async (e) => {
            const { index } = e.detail;
            const chat = chatService.getCurrentChat();
            if (!chat || index < 0 || index >= chat.messages.length) return;

            const messageId = chat.messages[index].id;
            const newChatId = await chatService.forkChat(chat.id, messageId);
            chatService.selectChat(newChatId);
        });
    }

    displayChat(chat) {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';

        if (!chat || chat.messages.length === 0) {
            container.innerHTML = this.buildWelcomeScreen();
            this.attachPromptClickHandlers();
            // Notify input area about stream status for this chat
            eventBus.emit(Events.STREAM_STATUS_CHANGED, { streaming: false });
            return;
        }

        chat.messages.forEach((msg, index) => {
            if (msg.role === 'tool') {
                this.appendToolMessage(msg, index);
            } else {
                this.appendMessage(msg.role, msg.content, msg.thinking, false, msg.model || chat.model, index, msg.stats, msg.images, msg.documents);
            }
        });

        // Restore context meter data for this chat
        if (chat.contextData) {
            eventBus.emit(Events.CONTEXT_UPDATED, {
                used: chat.contextData.used,
                max: chat.contextData.max,
                model: chat.model,
                summarized: !!chat.summary,
                summaryText: chat.summary || null
            });
        }

        // Check if this chat has an active background stream
        const streamState = this.activeStreams.get(chat.id);
        if (streamState && !streamState.completed) {
            // Re-create streaming message DOM and wire it up
            const { messageEl, contentEl } = this.createStreamingMessage();

            // Restore thinking block if present
            if (streamState.fullThinking) {
                const thinkingBlock = createThinkingBlock(
                    streamState.fullThinking,
                    getDefaultCollapsedState()
                );
                if (!streamState.thinkingDone) {
                    thinkingBlock.classList.add('thinking-active');
                }
                messageEl.insertBefore(thinkingBlock, contentEl);
                streamState.thinkingBlock = thinkingBlock;
            }

            // Restore accumulated content
            if (streamState.fullContent) {
                contentEl.innerHTML = renderMarkdown(streamState.fullContent);
                renderLatexInElement(contentEl);
            }

            // Update stream state references so onChunk writes to new DOM
            streamState.messageEl = messageEl;
            streamState.contentEl = contentEl;
            this.currentStreamEl = contentEl;
            this.currentThinkingBlock = streamState.thinkingBlock || null;

            // Notify input area that this chat is streaming
            eventBus.emit(Events.STREAM_STATUS_CHANGED, { streaming: true });
        } else {
            // No active stream for this chat
            eventBus.emit(Events.STREAM_STATUS_CHANGED, { streaming: false });
        }

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            refreshIcons();
        }

        this.scrollToBottom(true);
    }

    async handleUserMessage(content, images = null, documents = null) {
        // Ensure we have a chat — create on first message, not on "New Chat" click
        if (!chatService.getCurrentChat()) {
            if (!this.selectedModel) {
                console.error('No model selected');
                return;
            }
            const pendingFolder = chatService.pendingFolderId;
            chatService.createChat(this.selectedModel);
            if (pendingFolder) {
                chatService.moveChatToFolder(chatService.getCurrentChatId(), pendingFolder);
                chatService.pendingFolderId = null;
            }
        }

        // Add user message with images and documents
        chatService.addMessage('user', content, '', null, images, documents);
        const chat = chatService.getCurrentChat();
        const userMsgIndex = chat.messages.length - 1;
        this.appendMessage('user', content, '', true, null, userMsgIndex, null, images, documents);
        this.scrollToBottom(true);

        // Start streaming response
        await this.streamResponse();
    }

    async streamResponse() {
        const chat = chatService.getCurrentChat();
        if (!chat) return;

        // Capture the chat ID at invocation so background streams save to the right chat
        const streamChatId = chat.id;
        const streamProvider = providerManager.getProvider();

        // Create a dedicated AbortController for this stream
        const abortController = new AbortController();

        eventBus.emit(Events.STREAM_START, { chatId: streamChatId });

        // Create placeholder for streaming response and scroll it into view
        const { messageEl, contentEl } = this.createStreamingMessage();
        this.currentStreamEl = contentEl;
        this.currentThinkingBlock = null;
        this.scrollToBottom(true);

        // Register in activeStreams
        const streamState = {
            messageEl,
            contentEl,
            thinkingBlock: null,
            fullContent: '',
            fullThinking: '',
            _thinkingBase: '', // thinking accumulated from previous tool-call iterations
            thinkingDone: false,
            completed: false,
            abortController
        };
        this.activeStreams.set(streamChatId, streamState);

        try {
            // Get model parameters from settings (per-model)
            const modelParams = getModelParams(chat.model);
            const maxCtx = modelParams.num_ctx || 4096;

            const isViewing = () => chatService.getCurrentChatId() === streamChatId;

            // Get messages with smart context management (may summarize)
            if (isViewing()) {
                streamState.contentEl.innerHTML = '<span class="summarizing-hint"><span class="blink-dot">●</span> Preparing context...</span>';
            }
            let systemPrompt = chatService.getSystemPrompt();

            // ── RAG: auto-inject relevant document context ───────────────
            if (await ragService.hasReadyDocuments(streamChatId)) {
                // Find the last user message as the query
                const lastUserMsg = [...chat.messages].reverse().find(m => m.role === 'user');
                if (lastUserMsg) {
                    try {
                        const ragResults = await ragService.search(lastUserMsg.content, streamChatId);
                        if (ragResults.length > 0) {
                            const ragContext = ragService.formatContext(ragResults);
                            const ragPrefix = `The user has uploaded documents. Here is relevant context from those documents — use it to answer the user's question. Cite the source when using this information:\n\n${ragContext}\n\n`;
                            systemPrompt = ragPrefix + (systemPrompt || '');
                        }
                    } catch (err) {
                        console.warn('[RAG] Search failed, continuing without context:', err);
                    }
                }
            }

            const prepared = await chatService.getMessagesForApi(maxCtx, systemPrompt);
            let apiMessages = prepared.messages;

            if (isViewing()) {
                streamState.contentEl.innerHTML = '<span class="waiting-hint"><span class="blink-dot">●</span> Waiting for model...</span>';
            }

            // Build tool list: builtins from settings, web search from toggle
            const enabledCategories = [];
            const settings = storageService.loadSettings();
            if (settings.toolsEnabled !== false) enabledCategories.push('builtin');
            if (this.webSearchEnabled) enabledCategories.push('web_search');
            const tools = enabledCategories.length > 0
                ? toolRegistry.getSchemas({ categories: enabledCategories })
                : [];
            const MAX_TOOL_ITERATIONS = 5;
            let finalResult = null;

            for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
                // Reset content for subsequent iterations, keep thinking block
                if (iter > 0) {
                    streamState.fullContent = '';
                    // Carry forward accumulated thinking so iter N+1 appends, not replaces
                    streamState._thinkingBase = streamState.fullThinking;
                    // Ensure existing thinking block shows as completed (not blinking)
                    if (streamState.thinkingBlock && !streamState.thinkingDone) {
                        streamState.thinkingDone = true;
                        streamState.thinkingBlock.classList.remove('thinking-active');
                        const label = streamState.thinkingBlock.querySelector('.thinking-label');
                        if (label) label.textContent = 'Thinking';
                    }
                }

                let waitingCleared = false;

                const result = await streamProvider.chat(
                    chat.model,
                    apiMessages,
                    (chunk) => {
                        // Always update stream state (even if viewing another chat)
                        streamState.fullContent = chunk.fullContent;
                        // Accumulate thinking across all iterations
                        const totalThinking = streamState._thinkingBase + (chunk.fullThinking || '');
                        streamState.fullThinking = totalThinking;

                        // Only update DOM if user is viewing this chat
                        if (!isViewing()) return;

                        // Clear "Waiting for model..." on first chunk
                        if (!waitingCleared) {
                            streamState.contentEl.innerHTML = '';
                            waitingCleared = true;
                        }

                        // Update thinking block
                        if (totalThinking) {
                            if (!streamState.thinkingBlock) {
                                streamState.thinkingBlock = createThinkingBlock(
                                    totalThinking,
                                    getDefaultCollapsedState()
                                );
                                streamState.messageEl.insertBefore(streamState.thinkingBlock, streamState.contentEl);
                                this.currentThinkingBlock = streamState.thinkingBlock;
                                refreshIcons();
                            } else {
                                updateThinkingBlock(streamState.thinkingBlock, totalThinking);
                            }
                            if (chunk.isThinking && !streamState.thinkingDone) {
                                streamState.thinkingBlock.classList.add('thinking-active');
                            }
                        }

                        // Remove blinking once thinking is done
                        if (!chunk.isThinking && !streamState.thinkingDone && streamState.thinkingBlock) {
                            streamState.thinkingDone = true;
                            streamState.thinkingBlock.classList.remove('thinking-active');
                            const label = streamState.thinkingBlock.querySelector('.thinking-label');
                            if (label) label.textContent = 'Thinking';
                        }

                        // Update content (throttled to once per frame)
                        if (chunk.fullContent) {
                            if (!streamState._renderPending) {
                                streamState._renderPending = true;
                                requestAnimationFrame(() => {
                                    streamState._renderPending = false;
                                    if (streamState.contentEl && streamState.fullContent) {
                                        streamState.contentEl.innerHTML = renderMarkdown(streamState.fullContent);
                                        renderLatexInElement(streamState.contentEl);
                                        this.scrollToBottom();
                                    }
                                });
                            }
                        }
                    },
                    { options: modelParams, ...(tools.length ? { tools } : {}), signal: abortController.signal }
                );

                finalResult = result;
                console.debug('[Tools] iter', iter, 'content:', result.content?.slice(0, 80), 'toolCalls:', result.toolCalls);

                // No tool calls → final response, done
                if (!result.toolCalls || result.toolCalls.length === 0) break;

                // Stop thinking block blinking before executing tools
                if (streamState.thinkingBlock && !streamState.thinkingDone) {
                    streamState.thinkingDone = true;
                    streamState.thinkingBlock.classList.remove('thinking-active');
                    const label = streamState.thinkingBlock.querySelector('.thinking-label');
                    if (label) label.textContent = 'Thinking';
                }

                // Add the assistant's tool-call turn to context
                apiMessages.push({
                    role: 'assistant',
                    content: streamState.fullContent || '',
                    tool_calls: result.toolCalls
                });

                // Execute each tool silently and inject results into context
                for (const toolCall of result.toolCalls) {
                    const name = toolCall.function.name;
                    let args;
                    try {
                        args = typeof toolCall.function.arguments === 'string'
                            ? JSON.parse(toolCall.function.arguments)
                            : (toolCall.function.arguments || {});
                    } catch {
                        args = {};
                    }

                    let toolResult;
                    try {
                        toolResult = await toolRegistry.execute(name, args);
                    } catch (err) {
                        toolResult = `Error: ${err.message}`;
                    }

                    apiMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id || name,
                        content: toolResult
                    });
                }

                // Reset the existing placeholder for the model's follow-up response
                if (isViewing()) {
                    streamState.contentEl.innerHTML = '<span class="waiting-hint"><span class="blink-dot">●</span> Waiting for model...</span>';
                    this.scrollToBottom(true);
                }
            }

            const result = finalResult;

            // If tools were enabled but model turned out not to support them, update UI
            if (this.webSearchEnabled && streamProvider.supportsTools && !streamProvider.supportsTools(chat.model)) {
                eventBus.emit(Events.TOOLS_CAPABILITY_CHANGED, { supportsTools: false });
            }

            // Stream completed — persist to the correct chat
            const totalUsed = (result.promptEvalCount || 0) + (result.evalCount || 0);

            // Only update context/stats if we got a real result (not an aborted empty return)
            if (totalUsed > 0) {
                if (isViewing()) {
                    eventBus.emit(Events.CONTEXT_UPDATED, {
                        used: totalUsed,
                        max: maxCtx,
                        model: chat.model,
                        summarized: prepared.summarized,
                        summaryText: prepared.summarized ? chatService.getChat(streamChatId)?.summary : null
                    });
                }

                chatService.updateContextDataForChat(streamChatId, totalUsed, maxCtx);
                chatService.updateTokenCountForChat(streamChatId, totalUsed);
            }

            const statsData = {
                evalCount: result.evalCount,
                evalDuration: result.evalDuration,
                promptEvalCount: result.promptEvalCount,
                promptEvalDuration: result.promptEvalDuration,
                totalDuration: result.totalDuration,
                doneReason: result.doneReason
            };

            // Add stats bar only if viewing this chat and we have stats
            if (isViewing() && result.evalCount) {
                const stats = this.buildMessageStats(result);
                if (stats) {
                    streamState.messageEl.appendChild(stats);
                }
            }

            // Save final message to the correct chat (skip if empty/aborted)
            if (streamState.fullContent) {
                chatService.addMessageToChat(streamChatId, 'assistant', streamState.fullContent, streamState.fullThinking, statsData);

                const appSettings = storageService.loadSettings();

                // Generate title after the first exchange
                if (appSettings.titleEnabled !== false) {
                    const updatedChat = chatService.getChat(streamChatId);
                    if (updatedChat && updatedChat.messages.length === 2) {
                        const firstUserMsg = updatedChat.messages.find(m => m.role === 'user');
                        if (firstUserMsg) {
                            this.generateChatTitle(updatedChat, firstUserMsg.content, streamState.fullContent);
                        }
                    }
                }

                // Trigger background summarization if context is getting full
                if (appSettings.summarizationEnabled !== false) {
                    this.maybeRunBackgroundSummarization(streamChatId, maxCtx);
                }
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('Stream aborted for chat:', streamChatId);
            } else {
                console.error('Stream error:', error);
                // Only show error in DOM if user is viewing this chat
                if (chatService.getCurrentChatId() === streamChatId) {
                    streamState.contentEl.innerHTML = `
                        <span class="error-message">
                            <i data-lucide="alert-triangle" class="icon"></i> Error: ${error.message}
                        </span>
                        <button class="retry-btn" title="Retry">
                            <i data-lucide="refresh-cw" class="icon"></i> Retry
                        </button>`;
                    const retryBtn = streamState.contentEl.querySelector('.retry-btn');
                    retryBtn.addEventListener('click', () => {
                        streamState.messageEl.remove();
                        this.streamResponse();
                    });
                    refreshIcons();
                }
                eventBus.emit(Events.STREAM_ERROR, { error, chatId: streamChatId });
            }
        }

        // Clean up
        streamState.completed = true;
        this.activeStreams.delete(streamChatId);
        this.currentStreamEl = null;
        this.currentThinkingBlock = null;
        eventBus.emit(Events.STREAM_END, { aborted: false, chatId: streamChatId });

        // Re-render to show all action buttons with correct indexes
        if (chatService.getCurrentChatId() === streamChatId) {
            this.displayChat(chatService.getCurrentChat());
        }
    }
    buildMessageStats(result) {
        if (!result || !result.evalCount) return null;

        const statsEl = document.createElement('div');
        statsEl.className = 'message-stats';

        const parts = [];

        // tok/s (eval_duration is in nanoseconds)
        if (result.evalDuration > 0) {
            const tokPerSec = result.evalCount / (result.evalDuration / 1e9);
            parts.push(`${tokPerSec.toFixed(2)} tok/s`);
        }

        // Total generated tokens
        parts.push(`${result.evalCount} tokens`);

        // Time to first token (prompt_eval_duration in nanoseconds)
        if (result.promptEvalDuration > 0) {
            const ttft = result.promptEvalDuration / 1e9;
            parts.push(`${ttft.toFixed(2)}s to first token`);
        }

        // Total time (total_duration in nanoseconds)
        if (result.totalDuration > 0) {
            const total = result.totalDuration / 1e9;
            parts.push(`${total.toFixed(2)}s total`);
        }

        // Stop reason
        if (result.doneReason) {
            const reasonMap = {
                'stop': 'Stop',
                'length': 'Max Length',
                'load': 'Model Load'
            };
            parts.push(`Stop reason: ${reasonMap[result.doneReason] || result.doneReason}`);
        }

        statsEl.textContent = parts.join(' • ');
        return statsEl;
    }

    appendMessage(role, content, thinking = '', animate = true, model = null, msgIndex = -1, stats = null, images = null, documents = null) {
        const container = document.getElementById('messages-container');

        // Remove welcome message if present
        const welcome = container.querySelector('.welcome-message');
        if (welcome) {
            welcome.remove();
        }

        const messageEl = document.createElement('div');
        messageEl.className = `message ${role}-message ${animate ? 'animate-in' : ''}`;
        if (msgIndex >= 0) {
            messageEl.dataset.index = msgIndex;
        }

        // Determine role display text
        const roleDisplay = role === 'user'
            ? '⟩ You'
            : `⟨ ${model || this.selectedModel || 'AI'}`;

        // Build action buttons based on role
        let actionButtons = `<button class="message-action-btn copy-btn" onclick="copyMessageContent(this)" title="Copy" aria-label="Copy"><i data-lucide="copy" class="icon"></i></button>`;

        if (role === 'assistant' && msgIndex >= 0) {
            actionButtons += `<button class="message-action-btn branch-btn" onclick="branchFromHere(${msgIndex})" title="Branch from here" aria-label="Branch from here"><i data-lucide="git-branch" class="icon"></i></button>`;
        }

        if (role === 'user' && msgIndex >= 0) {
            actionButtons += `<button class="message-action-btn edit-btn" onclick="editMessage(${msgIndex})" title="Edit message" aria-label="Edit message"><i data-lucide="pencil" class="icon"></i></button>`;
        }

        if (role === 'assistant' && msgIndex >= 0) {
            actionButtons += `<button class="message-action-btn regenerate-btn" onclick="regenerateFromHere(${msgIndex})" title="Regenerate from here" aria-label="Regenerate from here"><i data-lucide="rotate-cw" class="icon"></i></button>`;
        }

        const imageHtml = images && images.length > 0
            ? images.map(img =>
                `<img src="${img}" alt="Attached image" class="message-image-thumb">`
            ).join('')
            : '';

        const docHtml = documents && documents.length > 0
            ? documents.map(doc => {
                const sizeKB = (doc.size / 1024).toFixed(0);
                return `<div class="message-doc-badge">
                    <i data-lucide="file-text" class="icon"></i>
                    <span class="message-doc-name">${escapeHtml(doc.name)}</span>
                    <span class="message-doc-size">${sizeKB} KB</span>
                </div>`;
            }).join('')
            : '';

        const attachmentsHtml = (imageHtml || docHtml)
            ? `<div class="message-attachments">${imageHtml}${docHtml}</div>`
            : '';

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-role">${roleDisplay}</span>
                <div class="message-actions">
                    ${actionButtons}
                </div>
            </div>
            ${attachmentsHtml}
            <div class="message-content">${renderMarkdown(content)}</div>
        `;

        // Add thinking block if present
        if (thinking) {
            const thinkingBlock = createThinkingBlock(thinking, getDefaultCollapsedState());
            const contentEl = messageEl.querySelector('.message-content');
            messageEl.insertBefore(thinkingBlock, contentEl);
        }

        // Add stats bar from saved data
        if (stats && role === 'assistant') {
            const statsEl = this.buildMessageStats(stats);
            if (statsEl) {
                messageEl.appendChild(statsEl);
            }
        }

        container.appendChild(messageEl);

        // Render LaTeX in the message
        const contentEl = messageEl.querySelector('.message-content');
        renderLatexInElement(contentEl);

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            refreshIcons();
        }
    }

    appendToolMessage(msg, msgIndex) {
        const container = document.getElementById('messages-container');
        const welcome = container.querySelector('.welcome-message');
        if (welcome) welcome.remove();

        const el = document.createElement('div');
        el.className = 'message tool-message';
        if (msgIndex >= 0) el.dataset.index = msgIndex;

        el.innerHTML = `
            <div class="tool-message-header">
                <i data-lucide="terminal" class="icon"></i>
                <span class="tool-message-name">${escapeHtml(msg.toolName)}</span>
                <code class="tool-message-input">${escapeHtml(msg.input)}</code>
            </div>
            <div class="tool-message-result ${msg.error ? 'tool-message-error' : ''}">
                ${renderMarkdown(msg.content)}
            </div>
        `;

        container.appendChild(el);
        refreshIcons();
    }

    createStreamingMessage() {
        const container = document.getElementById('messages-container');

        // Remove welcome message if present
        const welcome = container.querySelector('.welcome-message');
        if (welcome) {
            welcome.remove();
        }

        const messageEl = document.createElement('div');
        messageEl.className = 'message assistant-message streaming';

        const chat = chatService.getCurrentChat();
        const modelDisplay = (chat && chat.model) || this.selectedModel || 'AI';

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-role">⟨ ${modelDisplay}</span>
                <div class="message-actions">
                    <button class="message-action-btn copy-btn" onclick="copyMessageContent(this)" title="Copy message" aria-label="Copy message"><i data-lucide="copy" class="icon"></i></button>
                </div>
            </div>
            <div class="message-content">
                <span class="cursor-blink">▌</span>
            </div>
        `;

        container.appendChild(messageEl);

        return {
            messageEl,
            contentEl: messageEl.querySelector('.message-content')
        };
    }

    /**
     * Generate a title for the chat using AI
     * @param {Object} chat - Chat object
     * @param {string} userMessage - User's first message
     * @param {string} assistantMessage - Assistant's response
     */
    async generateChatTitle(chat, userMessage, assistantMessage) {
        try {
            const title = await titleService.generateTitle(userMessage, assistantMessage);
            if (title && title !== 'New Chat') {
                chatService.updateChatTitle(chat.id, title);
                eventBus.emit(Events.TITLE_GENERATED, { chatId: chat.id, title });
            }
        } catch (error) {
            console.error('Failed to generate title:', error);
            // Keep the default title on error
        }
    }

    async maybeRunBackgroundSummarization(chatId, maxCtx) {
        const chat = chatService.getChat(chatId);
        if (!chat || !contextService.shouldSummarize(chat, maxCtx)) return;

        const notice = toast.info('Summarizing conversation history...', { duration: 0 });

        try {
            const result = await contextService.summarizeInBackground(chat, maxCtx);
            notice.dismiss();

            if (result) {
                chatService.updateSummary(chatId, result.summary, result.summarizedUpTo);
                toast.success('Conversation history summarized');

                // Update context meter immediately — show icon + tooltip text
                const updatedChat = chatService.getChat(chatId);
                if (updatedChat?.contextData) {
                    eventBus.emit(Events.CONTEXT_UPDATED, {
                        used: updatedChat.contextData.used,
                        max: updatedChat.contextData.max,
                        model: updatedChat.model,
                        summarized: true,
                        summaryText: result.summary
                    });
                }
            }
        } catch (error) {
            notice.dismiss();
            toast.error('Failed to summarize conversation history');
            console.error('Background summarization failed:', error);
        }
    }

    endsWithUserMessage(chat) {
        const msgs = chat?.messages;
        return msgs && msgs.length > 0 && msgs[msgs.length - 1].role === 'user';
    }

    scrollToBottom(force = false) {
        if (!force && this._userScrolledUp) return;
        const container = document.getElementById('messages-container');
        this._isProgrammaticScroll = true;
        container.scrollTop = container.scrollHeight;
        requestAnimationFrame(() => { this._isProgrammaticScroll = false; });
        if (force) {
            this._userScrolledUp = false;
            document.getElementById('scroll-to-bottom')?.classList.remove('visible');
        }
    }
}

export function createChatView(containerId) {
    return new ChatView(containerId);
}

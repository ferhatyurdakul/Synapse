/**
 * ChatView - Main chat display component with streaming support
 */

import { chatService } from '../services/chatService.js?v=27';
import { providerManager } from '../services/providerManager.js?v=27';
import { titleService } from '../services/titleService.js?v=27';
import { eventBus, Events } from '../utils/eventBus.js?v=27';
import { renderMarkdown, renderLatexInElement } from '../utils/markdown.js?v=27';
import { createThinkingBlock, updateThinkingBlock, getDefaultCollapsedState } from './thinkingBlock.js?v=27';
import { getModelParams } from './settingsPanel.js?v=27';

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

        this.init();
    }

    init() {
        this.render();
        this.listenToEvents();
    }

    render() {
        this.container.innerHTML = `
            <div class="chat-view">
                <div id="messages-container" class="messages-container">
                    ${this.buildWelcomeScreen()}
                </div>
            </div>
        `;
        this.attachPromptClickHandlers();
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

        eventBus.on(Events.MESSAGE_SENT, async ({ content }) => {
            await this.handleUserMessage(content);
        });

        eventBus.on(Events.STREAM_END, ({ aborted }) => {
            if (aborted) {
                providerManager.getProvider().abort();
            }
        });

        // Listen for resend message event from global handler
        window.addEventListener('resend-message', async (e) => {
            // Delete last assistant message and regenerate
            const chat = chatService.getCurrentChat();
            if (chat && chat.messages.length > 0) {
                // Remove last assistant message if exists
                const lastMsg = chat.messages[chat.messages.length - 1];
                if (lastMsg.role === 'assistant') {
                    chatService.deleteLastMessage();
                }
            }
            // Re-display chat (without adding user message again) and stream new response
            this.displayChat(chatService.getCurrentChat());
            await this.streamResponse();
        });
    }

    displayChat(chat) {
        const container = document.getElementById('messages-container');
        container.innerHTML = '';

        if (!chat || chat.messages.length === 0) {
            container.innerHTML = this.buildWelcomeScreen();
            this.attachPromptClickHandlers();
            return;
        }

        chat.messages.forEach((msg, index) => {
            const isLastUserMsg = msg.role === 'user' && index === chat.messages.length - 1;
            this.appendMessage(msg.role, msg.content, msg.thinking, false, msg.model || chat.model, isLastUserMsg);
        });

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        this.scrollToBottom();
    }

    async handleUserMessage(content) {
        // Ensure we have a chat
        if (!chatService.getCurrentChat()) {
            if (!this.selectedModel) {
                console.error('No model selected');
                return;
            }
            chatService.createChat(this.selectedModel);
        }

        // Add user message
        chatService.addMessage('user', content);
        this.appendMessage('user', content);
        this.scrollToBottom();

        // Start streaming response
        await this.streamResponse();
    }

    async streamResponse() {
        const chat = chatService.getCurrentChat();
        if (!chat) return;

        eventBus.emit(Events.STREAM_START, {});

        // Create placeholder for streaming response
        const { messageEl, contentEl } = this.createStreamingMessage();
        this.currentStreamEl = contentEl;
        this.currentThinkingBlock = null;

        let fullContent = '';
        let fullThinking = '';

        try {
            // Get model parameters from settings (per-model)
            const modelParams = getModelParams(chat.model);
            const maxCtx = modelParams.num_ctx || 4096;

            // Get messages with smart context management (may summarize)
            contentEl.innerHTML = '<span class="summarizing-hint">Preparing context...</span>';
            const prepared = await chatService.getMessagesForApi(maxCtx);
            contentEl.innerHTML = '';

            const result = await providerManager.getProvider().chat(
                chat.model,
                prepared.messages,
                (chunk) => {
                    fullContent = chunk.fullContent;
                    fullThinking = chunk.fullThinking;

                    // Update thinking block
                    if (chunk.fullThinking) {
                        if (!this.currentThinkingBlock) {
                            this.currentThinkingBlock = createThinkingBlock(
                                chunk.fullThinking,
                                getDefaultCollapsedState()
                            );
                            messageEl.insertBefore(this.currentThinkingBlock, contentEl);
                        } else {
                            updateThinkingBlock(this.currentThinkingBlock, chunk.fullThinking);
                        }
                    }

                    // Update content
                    if (chunk.fullContent) {
                        contentEl.innerHTML = renderMarkdown(chunk.fullContent);
                        // Re-render LaTeX after content update
                        renderLatexInElement(contentEl);
                    }

                    this.scrollToBottom();
                },
                { options: modelParams }
            );

            // Emit context usage data
            const totalUsed = result.promptEvalCount + result.evalCount;
            eventBus.emit(Events.CONTEXT_UPDATED, {
                used: totalUsed,
                max: maxCtx,
                model: chat.model,
                summarized: prepared.summarized
            });

            // Store actual token count for next summarization decision
            chatService.updateTokenCount(totalUsed);

            // Add message stats bar
            const stats = this.buildMessageStats(result);
            if (stats) {
                messageEl.appendChild(stats);
            }

            // Save final message
            chatService.addMessage('assistant', fullContent, fullThinking);

            // Generate title for new chats (after first exchange)
            const updatedChat = chatService.getCurrentChat();
            // Check if this is the first message exchange (user + assistant = 2 messages)
            // Note: addMessage already sets a fallback title, so we generate AI title after first exchange
            if (updatedChat && updatedChat.messages.length === 2) {
                // Get the user's first message from the chat
                const firstUserMessage = updatedChat.messages[0]?.content || '';
                this.generateChatTitle(updatedChat, firstUserMessage, fullContent);
            }

        } catch (error) {
            console.error('Stream error:', error);
            contentEl.innerHTML = `<span class="error-message">⚠ Error: ${error.message}</span>`;
            eventBus.emit(Events.STREAM_ERROR, { error });
        }

        this.currentStreamEl = null;
        this.currentThinkingBlock = null;
        eventBus.emit(Events.STREAM_END, { aborted: false });
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

    appendMessage(role, content, thinking = '', animate = true, model = null, isLastUserMessage = false) {
        const container = document.getElementById('messages-container');

        // Remove welcome message if present
        const welcome = container.querySelector('.welcome-message');
        if (welcome) {
            welcome.remove();
        }

        // Remove resend button from previous user messages
        if (role === 'user') {
            const prevResendBtns = container.querySelectorAll('.resend-btn');
            prevResendBtns.forEach(btn => btn.remove());
        }

        const messageEl = document.createElement('div');
        messageEl.className = `message ${role}-message ${animate ? 'animate-in' : ''}`;

        const timestamp = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        // Determine role display text
        const roleDisplay = role === 'user'
            ? '⟩ You'
            : `⟨ ${model || this.selectedModel || 'AI'}`;

        // Build action buttons
        let actionButtons = `<button class="message-action-btn copy-btn" onclick="copyMessageContent(this)" title="Copy message"><i data-lucide="copy" class="icon"></i></button>`;

        // Add resend button only for user messages (will be shown only on last one)
        if (role === 'user') {
            actionButtons += `<button class="message-action-btn resend-btn" onclick="resendMessage(this)" title="Resend message">🔄</button>`;
        }

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-role">${roleDisplay}</span>
                <div class="message-actions">
                    ${actionButtons}
                </div>
                <span class="message-time">${timestamp}</span>
            </div>
            <div class="message-content">${renderMarkdown(content)}</div>
        `;

        // Add thinking block if present
        if (thinking) {
            const thinkingBlock = createThinkingBlock(thinking, getDefaultCollapsedState());
            const contentEl = messageEl.querySelector('.message-content');
            messageEl.insertBefore(thinkingBlock, contentEl);
        }

        container.appendChild(messageEl);

        // Render LaTeX in the message
        const contentEl = messageEl.querySelector('.message-content');
        renderLatexInElement(contentEl);

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
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

        const timestamp = new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

        const modelDisplay = this.selectedModel || 'AI';

        messageEl.innerHTML = `
            <div class="message-header">
                <span class="message-role">⟨ ${modelDisplay}</span>
                <div class="message-actions">
                    <button class="message-action-btn copy-btn" onclick="copyMessageContent(this)" title="Copy message"><i data-lucide="copy" class="icon"></i></button>
                </div>
                <span class="message-time">${timestamp}</span>
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

    scrollToBottom() {
        const container = document.getElementById('messages-container');
        container.scrollTop = container.scrollHeight;
    }
}

export function createChatView(containerId) {
    return new ChatView(containerId);
}

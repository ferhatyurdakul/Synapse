/**
 * InputArea - User input component with send functionality
 */

import { eventBus, Events } from '../utils/eventBus.js?v=18';

class InputArea {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isStreaming = false;

        this.init();
    }

    init() {
        this.render();
        this.attachEvents();
        this.listenToEvents();
    }

    render() {
        this.container.innerHTML = `
            <div class="input-area">
                <div class="input-wrapper">
                    <textarea 
                        id="message-input" 
                        class="terminal-input"
                        placeholder="Enter your message..."
                        rows="1"
                    ></textarea>
                    <button id="send-btn" class="send-btn" title="Send message">
                        <span class="send-icon">▶</span>
                    </button>
                    <button id="stop-btn" class="stop-btn hidden" title="Stop generation">
                        <span class="stop-icon">■</span>
                    </button>
                </div>
                <div class="input-hint">
                    Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
                </div>
            </div>
        `;
    }

    attachEvents() {
        const input = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const stopBtn = document.getElementById('stop-btn');

        // Auto-resize textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        });

        // Handle Enter key
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Send button click
        sendBtn.addEventListener('click', () => this.sendMessage());

        // Stop button click
        stopBtn.addEventListener('click', () => {
            eventBus.emit(Events.STREAM_END, { aborted: true });
        });
    }

    listenToEvents() {
        eventBus.on(Events.STREAM_START, () => {
            this.setStreaming(true);
        });

        eventBus.on(Events.STREAM_END, () => {
            this.setStreaming(false);
        });

        eventBus.on(Events.STREAM_ERROR, () => {
            this.setStreaming(false);
        });
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value.trim();

        if (!message || this.isStreaming) return;

        eventBus.emit(Events.MESSAGE_SENT, { content: message });

        // Clear input
        input.value = '';
        input.style.height = 'auto';
        input.focus();
    }

    setStreaming(isStreaming) {
        this.isStreaming = isStreaming;
        const sendBtn = document.getElementById('send-btn');
        const stopBtn = document.getElementById('stop-btn');
        const input = document.getElementById('message-input');

        if (isStreaming) {
            sendBtn.classList.add('hidden');
            stopBtn.classList.remove('hidden');
            input.disabled = true;
        } else {
            sendBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            input.disabled = false;
            input.focus();
        }
    }

    focus() {
        document.getElementById('message-input')?.focus();
    }
}

export function createInputArea(containerId) {
    return new InputArea(containerId);
}

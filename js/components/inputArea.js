/**
 * InputArea - User input component with send functionality
 */

import { eventBus, Events } from '../utils/eventBus.js?v=35';
import { chatService } from '../services/chatService.js?v=35';
import { storageService } from '../services/storageService.js?v=35';
import { toast } from './toast.js?v=35';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB hard reject
const MAX_IMAGE_PX = 1920;                // longest side after downscale
const JPEG_QUALITY = 0.85;

class InputArea {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isStreaming = false;
        this.supportsVision = false;
        this.pendingImages = [];
        this.webSearchEnabled = false;
        this.webSearchConfigured = false;
        this.modelSupportsTools = true;

        this.init();
    }

    init() {
        this.render();
        this.attachEvents();
        this.listenToEvents();
        this.updateWebSearchAvailability();
    }

    isWebSearchConfigured() {
        const settings = storageService.loadSettings();
        const provider = settings.searchProvider || 'searxng';
        if (provider === 'brave') {
            return !!settings.braveApiKey;
        }
        // SearXNG — configured if a URL is set (or using default)
        return true;
    }

    updateWebSearchAvailability() {
        this.webSearchConfigured = this.isWebSearchConfigured();
        const webSearchBtn = document.getElementById('web-search-btn');
        if (!webSearchBtn) return;

        // Hide completely if model doesn't support tools
        if (!this.modelSupportsTools) {
            webSearchBtn.classList.add('hidden');
            if (this.webSearchEnabled) {
                this.webSearchEnabled = false;
                webSearchBtn.classList.remove('active');
                eventBus.emit(Events.WEB_SEARCH_TOGGLED, { enabled: false });
            }
            return;
        }

        webSearchBtn.classList.remove('hidden');

        // Gray out if search isn't configured
        if (!this.webSearchConfigured) {
            webSearchBtn.classList.add('disabled');
            webSearchBtn.title = 'Web search not configured — set up in Settings';
            if (this.webSearchEnabled) {
                this.webSearchEnabled = false;
                webSearchBtn.classList.remove('active');
                eventBus.emit(Events.WEB_SEARCH_TOGGLED, { enabled: false });
            }
        } else {
            webSearchBtn.classList.remove('disabled');
            webSearchBtn.title = 'Toggle web search';
        }
    }

    render() {
        this.container.innerHTML = `
            <div class="input-area">
                <div id="image-preview-strip" class="image-preview-strip hidden"></div>
                <div class="input-wrapper">
                    <input type="file" id="image-file-input" accept="image/*" multiple class="hidden">
                    <button id="web-search-btn" class="web-search-btn" title="Toggle web search" aria-label="Toggle web search">
                        <i data-lucide="globe" class="icon"></i>
                    </button>
                    <button id="attach-image-btn" class="attach-image-btn hidden" title="Attach image" aria-label="Attach image">
                        <i data-lucide="image-plus" class="icon"></i>
                    </button>
                    <textarea
                        id="message-input"
                        class="terminal-input"
                        placeholder="Enter your message..."
                        rows="1"
                    ></textarea>
                    <button id="send-btn" class="send-btn" title="Send message" aria-label="Send message">
                        <i data-lucide="arrow-up" class="icon"></i>
                    </button>
                    <button id="stop-btn" class="stop-btn hidden" title="Stop generation" aria-label="Stop generation">
                        <i data-lucide="square" class="icon"></i>
                    </button>
                </div>
                <div class="input-hint">
                    Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
                </div>
            </div>
        `;

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            refreshIcons();
        }
    }

    attachEvents() {
        const input = document.getElementById('message-input');
        const sendBtn = document.getElementById('send-btn');
        const stopBtn = document.getElementById('stop-btn');
        const attachBtn = document.getElementById('attach-image-btn');
        const fileInput = document.getElementById('image-file-input');

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

        // Clipboard paste for images
        input.addEventListener('paste', (e) => {
            if (!this.supportsVision) return;
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) this.addImageFile(file);
                }
            }
        });

        // Send button click
        sendBtn.addEventListener('click', () => this.sendMessage());

        // Stop button click
        stopBtn.addEventListener('click', () => {
            eventBus.emit(Events.STREAM_END, { aborted: true });
        });

        // Web search toggle
        const webSearchBtn = document.getElementById('web-search-btn');
        webSearchBtn.addEventListener('click', () => {
            if (webSearchBtn.classList.contains('disabled')) {
                toast.warning('Web search not configured. Set it up in Settings → Web Search.');
                return;
            }
            this.webSearchEnabled = !this.webSearchEnabled;
            webSearchBtn.classList.toggle('active', this.webSearchEnabled);
            eventBus.emit(Events.WEB_SEARCH_TOGGLED, { enabled: this.webSearchEnabled });
        });

        // Attach image button
        attachBtn.addEventListener('click', () => {
            fileInput.click();
        });

        // File input change
        fileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (!files) return;
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    this.addImageFile(file);
                }
            }
            fileInput.value = '';
        });
    }

    listenToEvents() {
        eventBus.on(Events.STREAM_START, ({ chatId }) => {
            // Only enter streaming mode if the stream is for the current chat
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(true);
            }
        });

        eventBus.on(Events.STREAM_END, ({ chatId }) => {
            // Only exit streaming mode if the ended stream is for the current chat
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(false);
            }
        });

        eventBus.on(Events.STREAM_ERROR, ({ chatId }) => {
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(false);
            }
        });

        // When switching chats, sync streaming state to the new chat
        eventBus.on(Events.STREAM_STATUS_CHANGED, ({ streaming }) => {
            this.setStreaming(streaming);
        });

        eventBus.on(Events.TOOLS_CAPABILITY_CHANGED, ({ supportsTools }) => {
            this.modelSupportsTools = supportsTools;
            this.updateWebSearchAvailability();
        });

        eventBus.on(Events.SETTINGS_UPDATED, () => {
            this.updateWebSearchAvailability();
        });

        eventBus.on(Events.VISION_CAPABILITY_CHANGED, ({ supportsVision }) => {
            this.supportsVision = supportsVision;
            const attachBtn = document.getElementById('attach-image-btn');
            if (attachBtn) {
                if (supportsVision) {
                    attachBtn.classList.remove('hidden');
                } else {
                    attachBtn.classList.add('hidden');
                    this.clearPendingImages();
                }
            }
        });
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value.trim();

        if (!message && this.pendingImages.length === 0) return;
        if (this.isStreaming) return;

        const payload = { content: message || '' };
        if (this.pendingImages.length > 0) {
            payload.images = [...this.pendingImages];
        }

        eventBus.emit(Events.MESSAGE_SENT, payload);

        // Clear input and images
        input.value = '';
        input.style.height = 'auto';
        this.clearPendingImages();
        input.focus();
    }

    async addImageFile(file) {
        if (file.size > MAX_IMAGE_BYTES) {
            toast.error(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 20 MB.`);
            return;
        }
        try {
            const dataUrl = await this._resizeImage(file);
            this.pendingImages.push(dataUrl);
            this.renderImagePreviews();
        } catch (err) {
            console.error('Failed to process image:', err);
            toast.error('Failed to process image.');
        }
    }

    async _resizeImage(file) {
        const bitmap = await createImageBitmap(file);
        const { width, height } = bitmap;

        let targetW = width;
        let targetH = height;
        if (width > MAX_IMAGE_PX || height > MAX_IMAGE_PX) {
            const ratio = Math.min(MAX_IMAGE_PX / width, MAX_IMAGE_PX / height);
            targetW = Math.round(width * ratio);
            targetH = Math.round(height * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, targetW, targetH);
        bitmap.close();

        return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    }

    removeImage(index) {
        this.pendingImages.splice(index, 1);
        this.renderImagePreviews();
    }

    clearPendingImages() {
        this.pendingImages = [];
        this.renderImagePreviews();
    }

    renderImagePreviews() {
        const strip = document.getElementById('image-preview-strip');
        if (!strip) return;

        if (this.pendingImages.length === 0) {
            strip.classList.add('hidden');
            strip.innerHTML = '';
            return;
        }

        strip.classList.remove('hidden');
        strip.innerHTML = this.pendingImages.map((img, i) => `
            <div class="image-preview-item">
                <img src="${img}" alt="Attached image ${i + 1}">
                <button class="image-remove-btn" data-index="${i}" title="Remove image" aria-label="Remove image"><i data-lucide="x" class="icon"></i></button>
            </div>
        `).join('');

        // Attach remove handlers
        strip.querySelectorAll('.image-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index);
                this.removeImage(idx);
            });
        });

        refreshIcons();
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

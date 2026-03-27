/**
 * InputArea - User input component with send functionality
 */

import { eventBus, Events } from '../utils/eventBus.js?v=36';
import { chatService } from '../services/chatService.js?v=36';
import { storageService } from '../services/storageService.js?v=36';
import { ragService } from '../services/ragService.js?v=36';
import { toast } from './toast.js?v=36';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB hard reject
const MAX_IMAGE_PX = 1920;                // longest side after downscale
const JPEG_QUALITY = 0.85;
const RAG_FILE_TYPES = ['.pdf', '.txt', '.md', '.markdown', '.text'];
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

class InputArea {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.isStreaming = false;
        this.supportsVision = false;
        this.pendingImages = [];
        /** @type {Array<{id: string, file: File, status: 'pending'|'embedding'|'ready'|'error', progress: number}>} */
        this.pendingFiles = [];
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
        return true;
    }

    updateWebSearchAvailability() {
        this.webSearchConfigured = this.isWebSearchConfigured();
        const webSearchBtn = document.getElementById('web-search-btn');
        if (!webSearchBtn) return;

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
                <div id="attachments-strip" class="attachments-strip hidden"></div>
                <div class="input-wrapper">
                    <input type="file" id="image-file-input" accept="image/*" multiple class="hidden">
                    <input type="file" id="doc-file-input" accept=".pdf,.txt,.md,.markdown,.text" multiple class="hidden">
                    <button id="web-search-btn" class="web-search-btn" title="Toggle web search" aria-label="Toggle web search">
                        <i data-lucide="globe" class="icon"></i>
                    </button>
                    <button id="attach-file-btn" class="attach-file-btn" title="Attach files for knowledge base (PDF, TXT, MD)" aria-label="Attach files">
                        <i data-lucide="file-plus" class="icon"></i>
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
        const attachFileBtn = document.getElementById('attach-file-btn');
        const docFileInput = document.getElementById('doc-file-input');

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

        // Image file input change
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

        // Attach document file button
        attachFileBtn.addEventListener('click', () => {
            docFileInput.click();
        });

        // Document file input change
        docFileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (!files) return;
            for (const file of files) {
                this.addDocFile(file);
            }
            docFileInput.value = '';
        });

        // Drag and drop on input area
        const inputArea = this.container.querySelector('.input-area');
        inputArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            inputArea.classList.add('drag-over');
        });
        inputArea.addEventListener('dragleave', () => {
            inputArea.classList.remove('drag-over');
        });
        inputArea.addEventListener('drop', (e) => {
            e.preventDefault();
            inputArea.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (!files) return;
            for (const file of files) {
                if (this._isDocFile(file)) {
                    this.addDocFile(file);
                } else if (file.type.startsWith('image/') && this.supportsVision) {
                    this.addImageFile(file);
                }
            }
        });
    }

    listenToEvents() {
        eventBus.on(Events.STREAM_START, ({ chatId }) => {
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(true);
            }
        });

        eventBus.on(Events.STREAM_END, ({ chatId }) => {
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(false);
            }
        });

        eventBus.on(Events.STREAM_ERROR, ({ chatId }) => {
            if (!chatId || chatId === chatService.getCurrentChatId()) {
                this.setStreaming(false);
            }
        });

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

        // Track embedding progress for pending files
        eventBus.on(Events.RAG_EMBEDDING_PROGRESS, ({ documentId, completed, total }) => {
            const pf = this.pendingFiles.find(f => f.docId === documentId);
            if (pf) {
                pf.status = 'embedding';
                pf.progress = total > 0 ? completed / total : 0;
                this.renderAttachments();
            }
        });

        eventBus.on(Events.RAG_EMBEDDING_COMPLETE, ({ documentId }) => {
            const pf = this.pendingFiles.find(f => f.docId === documentId);
            if (pf) {
                pf.status = 'ready';
                pf.progress = 1;
                this.renderAttachments();
            }
        });

        eventBus.on(Events.RAG_EMBEDDING_ERROR, ({ documentId, error }) => {
            const pf = this.pendingFiles.find(f => f.docId === documentId);
            if (pf) {
                pf.status = 'error';
                this.renderAttachments();
                toast.error(`Embedding failed for ${pf.file.name}: ${error}`);
            }
        });
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const message = input.value.trim();

        if (!message && this.pendingImages.length === 0) return;
        if (this.isStreaming) return;

        // Block sending while files are still embedding
        const hasEmbedding = this.pendingFiles.some(f => f.status === 'pending' || f.status === 'embedding');
        if (hasEmbedding) {
            toast.warning('Please wait until documents finish embedding, or remove them to send now.');
            return;
        }

        const payload = { content: message || '' };
        if (this.pendingImages.length > 0) {
            payload.images = [...this.pendingImages];
        }
        // Attach document metadata for display in chat
        const readyFiles = this.pendingFiles.filter(f => f.status === 'ready');
        if (readyFiles.length > 0) {
            payload.documents = readyFiles.map(f => ({
                name: f.file.name,
                size: f.file.size
            }));
        }

        eventBus.emit(Events.MESSAGE_SENT, payload);

        // Clear input and attachments
        input.value = '';
        input.style.height = 'auto';
        this.clearPendingImages();
        this.pendingFiles = [];
        this.renderAttachments();
        input.focus();
    }

    // ── Document file handling ───────────────────────────────────────────

    _isDocFile(file) {
        const name = file.name.toLowerCase();
        return RAG_FILE_TYPES.some(ext => name.endsWith(ext)) ||
               file.type === 'application/pdf' ||
               file.type === 'text/plain' ||
               file.type === 'text/markdown';
    }

    async addDocFile(file) {
        if (!this._isDocFile(file)) {
            toast.error('Unsupported file type. Use PDF, TXT, or MD files.');
            return;
        }
        if (file.size > MAX_FILE_BYTES) {
            toast.error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`);
            return;
        }

        const entry = { id: generateLocalId(), file, status: 'pending', progress: 0, docId: null };
        this.pendingFiles.push(entry);
        this.renderAttachments();

        // Start ingestion immediately, scoped to current chat
        let chatId = chatService.getCurrentChatId();
        if (!chatId) {
            const model = storageService.loadSettings().selectedModel || null;
            chatId = chatService.createChat(model);
        }

        try {
            const doc = await ragService.ingestFile(file, chatId);
            entry.docId = doc.id;
            entry.status = 'embedding';
            this.renderAttachments();
        } catch (err) {
            entry.status = 'error';
            this.renderAttachments();
            toast.error(`Failed to process "${file.name}": ${err.message}`);
        }
    }

    removeDocFile(entryId) {
        const idx = this.pendingFiles.findIndex(f => f.id === entryId);
        if (idx === -1) return;
        const entry = this.pendingFiles[idx];

        // Remove from KB if it was ingested
        if (entry.docId) {
            ragService.deleteDocument(entry.docId).catch(console.error);
        }

        this.pendingFiles.splice(idx, 1);
        this.renderAttachments();
    }

    renderAttachments() {
        const strip = document.getElementById('attachments-strip');
        if (!strip) return;

        const hasImages = this.pendingImages.length > 0;
        const hasFiles = this.pendingFiles.length > 0;

        if (!hasImages && !hasFiles) {
            strip.classList.add('hidden');
            strip.innerHTML = '';
            this.updateSendBlocked();
            return;
        }

        strip.classList.remove('hidden');

        // Build image items
        const imageHtml = this.pendingImages.map((img, i) => `
            <div class="image-preview-item">
                <img src="${img}" alt="Attached image ${i + 1}">
                <button class="image-remove-btn" data-index="${i}" title="Remove image" aria-label="Remove image"><i data-lucide="x" class="icon"></i></button>
            </div>
        `).join('');

        // Build file items
        const fileHtml = this.pendingFiles.map(pf => {
            const pct = Math.round(pf.progress * 100);
            const statusClass = `file-status-${pf.status}`;
            const sizeKB = (pf.file.size / 1024).toFixed(0);
            const circumference = 88;
            const dashOffset = circumference - (circumference * pf.progress);

            return `
                <div class="file-preview-item ${statusClass}" data-entry-id="${pf.id}">
                    <div class="file-icon-wrap">
                        <i data-lucide="file-text" class="icon file-icon"></i>
                        ${pf.status === 'embedding' ? `
                            <svg class="file-progress-ring" viewBox="0 0 32 32">
                                <circle cx="16" cy="16" r="14" fill="none" stroke="var(--border-color)" stroke-width="2"/>
                                <circle cx="16" cy="16" r="14" fill="none" stroke="var(--accent-purple, #b18cff)" stroke-width="2"
                                    stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                                    stroke-linecap="round" transform="rotate(-90 16 16)"/>
                            </svg>
                        ` : ''}
                        ${pf.status === 'ready' ? '<span class="file-check"><i data-lucide="check" class="icon"></i></span>' : ''}
                        ${pf.status === 'error' ? '<span class="file-error-badge"><i data-lucide="alert-circle" class="icon"></i></span>' : ''}
                    </div>
                    <div class="file-info">
                        <span class="file-name">${escapeHtml(pf.file.name)}</span>
                        <span class="file-meta">${sizeKB} KB${pf.status === 'embedding' ? ` · ${pct}%` : pf.status === 'ready' ? ' · Ready' : pf.status === 'error' ? ' · Error' : ''}</span>
                    </div>
                    <button class="file-remove-btn" data-entry-id="${pf.id}" title="Remove file" aria-label="Remove file">
                        <i data-lucide="x" class="icon"></i>
                    </button>
                </div>
            `;
        }).join('');

        strip.innerHTML = imageHtml + fileHtml;

        // Wire image remove buttons
        strip.querySelectorAll('.image-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index);
                this.removeImage(idx);
            });
        });

        // Wire file remove buttons
        strip.querySelectorAll('.file-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.removeDocFile(btn.dataset.entryId);
            });
        });

        refreshIcons();
        this.updateSendBlocked();
    }

    /** Disable/enable send button based on active embedding jobs. */
    updateSendBlocked() {
        const sendBtn = document.getElementById('send-btn');
        if (!sendBtn) return;
        const blocked = this.pendingFiles.some(f => f.status === 'pending' || f.status === 'embedding');
        sendBtn.disabled = blocked;
        sendBtn.title = blocked ? 'Waiting for documents to finish embedding…' : 'Send message';
    }

    // ── Image handling (unchanged) ───────────────────────────────────────

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
        this.renderAttachments();
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

function generateLocalId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function createInputArea(containerId) {
    return new InputArea(containerId);
}

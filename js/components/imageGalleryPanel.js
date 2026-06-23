import { imageService } from '../services/imageService.js';
import { chatService } from '../services/chatService.js';
import { storageService } from '../services/storageService.js';
import { toast } from './toast.js';

function esc(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function date(value) { return value ? new Date(value).toLocaleString() : '—'; }
function tags(value) { return String(value || '').split(/[\n,;#]/).map(v => v.trim()).filter(Boolean); }

export function createImageGalleryPanel() { return new ImageGalleryPanel(); }

class ImageGalleryPanel {
    constructor() {
        this.images = [];
        this.folders = [];
        this.selectedId = null;
        this.query = '';
        this.folderId = '';
        this.editingMeta = false;
        this.el = document.createElement('section');
        this.el.className = 'ig-panel';
        this.el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.el);
        this.render();
    }

    isOpen() { return this.el.classList.contains('open'); }
    async open() {
        this.el.classList.add('open');
        this.el.setAttribute('aria-hidden', 'false');
        await this.load();
        setTimeout(() => this.el.querySelector('[data-ig-search]')?.focus(), 0);
    }
    close() {
        this.el.classList.remove('open');
        this.el.setAttribute('aria-hidden', 'true');
        this.editingMeta = false;
    }
    async load() {
        this.folders = await imageService.listFolders();
        this.images = await imageService.listImages({ query: this.query, folderId: this.folderId });
        if (!this.selectedId && this.images.length) this.selectedId = this.images[0].id;
        if (this.selectedId && !this.images.some(img => img.id === this.selectedId)) this.selectedId = this.images[0]?.id || null;
        this.render();
    }
    selected() { return this.images.find(img => img.id === this.selectedId) || null; }

    render() {
        const selected = this.selected();
        this.el.innerHTML = `
            <div class="ig-backdrop" data-ig-close></div>
            <div class="ig-shell" role="dialog" aria-modal="true" aria-label="Image gallery and editor">
                <header class="ig-header">
                    <div>
                        <p class="ig-kicker">Multimodal Workspace</p>
                        <h2>Image Gallery</h2>
                        <span>${this.images.length} visible · uploaded, generated, and edited media</span>
                    </div>
                    <button class="ig-icon-btn" data-ig-close title="Close" aria-label="Close">×</button>
                </header>
                <div class="ig-toolbar">
                    <input data-ig-search type="search" placeholder="Search title, prompt, model, tags…" value="${esc(this.query)}">
                    <select data-ig-folder-filter>
                        <option value="">All folders</option>
                        ${this.folders.map(folder => `<option value="${esc(folder.id)}" ${folder.id === this.folderId ? 'selected' : ''}>${esc(folder.name)}</option>`).join('')}
                    </select>
                    <button data-ig-upload>Upload Images</button>
                    <button data-ig-folder>New Folder</button>
                    <button data-ig-export ${selected ? '' : 'disabled'}>Export Selected</button>
                    <input data-ig-file type="file" accept="image/*" multiple hidden>
                </div>
                <main class="ig-main">
                    <aside class="ig-grid" data-ig-drop>
                        ${this.images.length ? this.images.map(img => this.renderCard(img)).join('') : this.renderEmpty()}
                    </aside>
                    <section class="ig-detail">
                        ${selected ? (this.editingMeta ? this.renderMetaForm(selected) : this.renderDetail(selected)) : this.renderIntro()}
                    </section>
                </main>
            </div>
        `;
        this.bind();
    }

    renderEmpty() {
        return `<div class="ig-empty"><h3>No images yet</h3><p>Upload PNG/JPEG/WebP/GIF files or save generated images here to reopen later without re-uploading.</p><button data-ig-upload>Upload your first image</button></div>`;
    }
    renderIntro() {
        return `<div class="ig-empty ig-empty-large"><h3>Build a local image library</h3><p>Store generated and uploaded media with prompts, model metadata, folders, versions, and chat/document attachment hooks.</p></div>`;
    }
    renderCard(img) {
        const active = img.id === this.selectedId ? 'active' : '';
        return `
            <button class="ig-card ${active}" data-ig-select="${esc(img.id)}">
                <img src="${esc(img.thumbnailDataUrl || img.dataUrl)}" alt="${esc(img.title)}">
                <span><strong>${esc(img.title)}</strong><small>${esc(img.model || img.sourceType || 'image')} · ${date(img.updatedAt)}</small></span>
            </button>
        `;
    }
    renderDetail(img) {
        const folder = this.folders.find(f => f.id === img.folderId)?.name || 'Unfiled';
        return `
            <div class="ig-preview-card">
                <img class="ig-preview" src="${esc(img.dataUrl)}" alt="${esc(img.title)}">
                <div class="ig-actions">
                    <button data-ig-edit>Edit Metadata</button>
                    <button data-ig-open-editor>Open Canvas Editor</button>
                    <button data-ig-chat>Attach To Chat</button>
                    <button data-ig-doc>Copy Document Embed</button>
                    <button data-ig-download>Download</button>
                    <button data-ig-archive>Archive</button>
                </div>
            </div>
            <div class="ig-card-detail">
                <h3>${esc(img.title)}</h3>
                <p>${esc(img.description || 'No description yet.')}</p>
                <div class="ig-meta-grid">
                    <div><label>Source</label><p>${esc(img.sourceType)}${img.sourceSession ? ` · ${esc(img.sourceSession)}` : ''}</p></div>
                    <div><label>Prompt</label><p>${esc(img.prompt || '—')}</p></div>
                    <div><label>Model</label><p>${esc(img.model || '—')}</p></div>
                    <div><label>Folder / Project</label><p>${esc(folder)}${img.projectId ? ` · ${esc(img.projectId)}` : ''}</p></div>
                    <div><label>Size</label><p>${img.width || '?'}×${img.height || '?'} · ${esc(img.mimeType)}</p></div>
                    <div><label>Timestamps</label><p>Created ${date(img.createdAt)}<br>Updated ${date(img.updatedAt)}</p></div>
                </div>
                <div class="ig-tags">${(img.tags || []).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
                <details class="ig-history"><summary>${(img.editHistory || []).length} edit/version notes</summary>${(img.editHistory || []).map(h => `<p><strong>${esc(h.label)}</strong> ${date(h.createdAt)}<br><small>${esc(h.prompt || h.editType || '')}</small></p>`).join('') || '<p>No versions yet.</p>'}</details>
            </div>
            <div class="ig-editor hidden" data-ig-editor></div>
        `;
    }
    renderMetaForm(img) {
        return `
            <form class="ig-form" data-ig-meta-form>
                <h3>Edit Image Metadata</h3>
                <label>Title <input name="title" required value="${esc(img.title)}"></label>
                <label>Description <textarea name="description">${esc(img.description)}</textarea></label>
                <div class="ig-two">
                    <label>Source session <input name="sourceSession" value="${esc(img.sourceSession)}"></label>
                    <label>Source chat id <input name="sourceChatId" value="${esc(img.sourceChatId || chatService.getCurrentChatId() || '')}"></label>
                </div>
                <div class="ig-two">
                    <label>Prompt <textarea name="prompt">${esc(img.prompt)}</textarea></label>
                    <label>Model <input name="model" value="${esc(img.model || storageService.loadSettings().selectedModel || '')}"></label>
                </div>
                <div class="ig-two">
                    <label>Project <input name="projectId" value="${esc(img.projectId)}"></label>
                    <label>Folder <select name="folderId"><option value="">Unfiled</option>${this.folders.map(folder => `<option value="${esc(folder.id)}" ${folder.id === img.folderId ? 'selected' : ''}>${esc(folder.name)}</option>`).join('')}</select></label>
                </div>
                <label>Tags <input name="tags" value="${esc((img.tags || []).join(', '))}"></label>
                <div class="ig-actions"><button type="submit">Save Metadata</button><button type="button" data-ig-cancel>Cancel</button></div>
            </form>
        `;
    }

    bind() {
        this.el.querySelectorAll('[data-ig-close]').forEach(el => el.addEventListener('click', () => this.close()));
        this.el.querySelectorAll('[data-ig-upload]').forEach(el => el.addEventListener('click', () => this.el.querySelector('[data-ig-file]')?.click()));
        this.el.querySelector('[data-ig-file]')?.addEventListener('change', e => this.importFiles(e.target.files));
        this.el.querySelector('[data-ig-search]')?.addEventListener('input', e => { this.query = e.target.value; this.load(); });
        this.el.querySelector('[data-ig-folder-filter]')?.addEventListener('change', e => { this.folderId = e.target.value; this.load(); });
        this.el.querySelectorAll('[data-ig-select]').forEach(btn => btn.addEventListener('click', () => { this.selectedId = btn.dataset.igSelect; this.editingMeta = false; this.render(); }));
        this.el.querySelector('[data-ig-folder]')?.addEventListener('click', () => this.createFolder());
        this.el.querySelector('[data-ig-export]')?.addEventListener('click', () => this.exportSelected());
        this.el.querySelector('[data-ig-edit]')?.addEventListener('click', () => { this.editingMeta = true; this.render(); });
        this.el.querySelector('[data-ig-cancel]')?.addEventListener('click', () => { this.editingMeta = false; this.render(); });
        this.el.querySelector('[data-ig-meta-form]')?.addEventListener('submit', e => this.saveMetadata(e));
        this.el.querySelector('[data-ig-open-editor]')?.addEventListener('click', () => this.openEditor());
        this.el.querySelector('[data-ig-chat]')?.addEventListener('click', () => this.attachToChat());
        this.el.querySelector('[data-ig-doc]')?.addEventListener('click', () => this.copyDocumentEmbed());
        this.el.querySelector('[data-ig-download]')?.addEventListener('click', () => this.downloadSelected());
        this.el.querySelector('[data-ig-archive]')?.addEventListener('click', () => this.archiveSelected());
        const drop = this.el.querySelector('[data-ig-drop]');
        if (drop) {
            drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
            drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
            drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); this.importFiles(e.dataTransfer.files); });
        }
        if (typeof refreshIcons !== 'undefined') refreshIcons();
    }

    async importFiles(files) {
        try {
            const imported = await imageService.importImageFiles(files, { sourceSession: 'Gallery upload', sourceChatId: chatService.getCurrentChatId() || '', model: storageService.loadSettings().selectedModel || '' });
            if (imported.length) this.selectedId = imported[0].id;
            toast.success(`Imported ${imported.length} image${imported.length === 1 ? '' : 's'}`);
            await this.load();
        } catch (err) { toast.error(err.message || 'Failed to import images'); }
    }
    async createFolder() {
        const name = prompt('Folder name');
        if (!name) return;
        const folder = await imageService.saveFolder({ name });
        this.folderId = folder.id;
        await this.load();
    }
    async saveMetadata(e) {
        e.preventDefault();
        const img = this.selected();
        const data = Object.fromEntries(new FormData(e.target).entries());
        await imageService.saveImage({ ...img, ...data, tags: tags(data.tags) });
        this.editingMeta = false;
        await this.load();
        toast.success('Image metadata saved');
    }
    async attachToChat() {
        const img = this.selected();
        if (!img) return;
        window.dispatchEvent(new CustomEvent('synapse:attachImageToChat', { detail: { dataUrl: img.dataUrl, title: img.title, imageId: img.id } }));
        toast.success('Image attached to chat input');
    }
    async copyDocumentEmbed() {
        const img = this.selected();
        if (!img) return;
        const md = imageService.imageMarkdown(img);
        await navigator.clipboard?.writeText(md);
        window.dispatchEvent(new CustomEvent('synapse:attachImageToDocument', { detail: { markdown: md, image: img } }));
        toast.success('Document embed copied and attachment event emitted');
    }
    downloadSelected() {
        const img = this.selected();
        if (img) imageService.downloadDataUrl(img.dataUrl, img.fileName || `${img.title || 'image'}.png`);
    }
    async exportSelected() {
        const img = this.selected();
        if (img) await imageService.exportBundle([img.id]);
    }
    async archiveSelected() {
        const img = this.selected();
        if (!img) return;
        await imageService.archiveImage(img.id, true);
        this.selectedId = null;
        await this.load();
        toast.success('Image archived');
    }

    async openEditor() {
        const img = this.selected();
        const host = this.el.querySelector('[data-ig-editor]');
        if (!img || !host) return;
        host.classList.remove('hidden');
        host.innerHTML = `
            <div class="ig-editor-head"><h3>Canvas Editor</h3><p>Crop, annotate, and save prompt-based edit notes as reopenable versions.</p></div>
            <canvas data-ig-canvas></canvas>
            <div class="ig-editor-tools">
                <label>X <input data-crop-x type="number" min="0" value="0"></label>
                <label>Y <input data-crop-y type="number" min="0" value="0"></label>
                <label>W <input data-crop-w type="number" min="1"></label>
                <label>H <input data-crop-h type="number" min="1"></label>
                <button data-ig-crop>Crop</button>
                <label>Annotate <input data-ig-annotate placeholder="Text label"></label>
                <button data-ig-text>Add Text</button>
                <label>Edit prompt <input data-ig-edit-prompt placeholder="e.g. make background warmer"></label>
                <button data-ig-grayscale>Grayscale</button>
                <button data-ig-save-version>Save Version</button>
            </div>
        `;
        const canvas = host.querySelector('[data-ig-canvas]');
        const ctx = canvas.getContext('2d');
        const image = new Image();
        image.onload = () => {
            const maxW = Math.min(900, host.clientWidth - 24);
            const scale = Math.min(maxW / image.width, 1);
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            host.querySelector('[data-crop-w]').value = canvas.width;
            host.querySelector('[data-crop-h]').value = canvas.height;
        };
        image.src = img.dataUrl;
        host.querySelector('[data-ig-text]').addEventListener('click', () => {
            const text = host.querySelector('[data-ig-annotate]').value.trim();
            if (!text) return;
            ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(18, canvas.height - 58, Math.min(canvas.width - 36, text.length * 9 + 28), 38);
            ctx.fillStyle = '#fff'; ctx.font = '18px sans-serif'; ctx.fillText(text, 32, canvas.height - 33);
        });
        host.querySelector('[data-ig-grayscale]').addEventListener('click', () => {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < pixels.data.length; i += 4) {
                const avg = (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 3;
                pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = avg;
            }
            ctx.putImageData(pixels, 0, 0);
        });
        host.querySelector('[data-ig-crop]').addEventListener('click', () => {
            const x = Number(host.querySelector('[data-crop-x]').value || 0), y = Number(host.querySelector('[data-crop-y]').value || 0);
            const w = Number(host.querySelector('[data-crop-w]').value || canvas.width), h = Number(host.querySelector('[data-crop-h]').value || canvas.height);
            const scratch = document.createElement('canvas'); scratch.width = w; scratch.height = h;
            scratch.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
            canvas.width = w; canvas.height = h; ctx.drawImage(scratch, 0, 0);
        });
        host.querySelector('[data-ig-save-version]').addEventListener('click', async () => {
            const prompt = host.querySelector('[data-ig-edit-prompt]').value.trim();
            await imageService.addImageVersion(img.id, { dataUrl: canvas.toDataURL('image/png'), label: prompt || 'Canvas edit', editType: 'canvas', prompt });
            await this.load();
            toast.success('Image version saved');
        });
    }
}

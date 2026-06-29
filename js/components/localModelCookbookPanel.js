import { localModelCookbookService } from '../services/localModelCookbookService.js';
import { toast } from './toast.js';

function esc(value = '') {
    return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function copyText(text, label = 'Copied') {
    navigator.clipboard?.writeText(text).then(() => toast.success(label)).catch(() => toast.error('Clipboard unavailable'));
}

class LocalModelCookbookPanel {
    constructor() {
        this.modal = null;
        this.state = { tab: 'hardware', settings: null, recommendation: null, selectedModelId: 'llama32-3b', selectedQuant: 'q4_K_M', selectedProvider: 'ollama', remotes: [], runbooks: [], benchmarks: [] };
    }

    async init() {
        this.state.settings = await localModelCookbookService.init();
        this.state.recommendation = localModelCookbookService.recommend();
        await this.refreshLists();
    }

    async refreshLists() {
        this.state.remotes = await localModelCookbookService.listRemoteProfiles();
        this.state.runbooks = await localModelCookbookService.listRunbooks();
        this.state.benchmarks = await localModelCookbookService.listBenchmarks();
    }

    open() { this.render(); }
    close() { this.modal?.remove(); this.modal = null; }
    isOpen() { return Boolean(this.modal); }

    async render() {
        if (!this.state.settings) await this.init();
        if (!this.modal) {
            this.modal = document.createElement('div');
            this.modal.className = 'lm-modal-backdrop';
            document.body.appendChild(this.modal);
        }
        this.modal.innerHTML = `
            <div class="lm-panel" role="dialog" aria-modal="true" aria-label="Local Model Cookbook">
                <header class="lm-header">
                    <div><p class="lm-kicker">Hardware-aware setup</p><h2>Local Model Cookbook</h2><p>Scan hardware, pick models, save runbooks, and record benchmark evidence.</p></div>
                    <button class="lm-close" type="button" data-action="close">×</button>
                </header>
                <nav class="lm-tabs">${['hardware','catalog','guides','remote','benchmarks'].map(t => `<button class="${this.state.tab === t ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</nav>
                <section class="lm-body">${this.renderTab()}</section>
            </div>`;
        this.bindEvents();
        refreshIcons();
    }

    renderTab() {
        if (this.state.tab === 'hardware') return this.renderHardware();
        if (this.state.tab === 'catalog') return this.renderCatalog();
        if (this.state.tab === 'guides') return this.renderGuides();
        if (this.state.tab === 'remote') return this.renderRemote();
        return this.renderBenchmarks();
    }

    renderHardware() {
        const p = this.state.settings.activeProfile;
        const rec = localModelCookbookService.recommend();
        this.state.recommendation = rec;
        return `
            <div class="lm-grid two">
                <form class="lm-card" data-form="profile">
                    <h3>Machine profile</h3>
                    <label>Name<input name="name" value="${esc(p.name)}"></label>
                    <label>OS / platform<input name="os" value="${esc(p.os)}"></label>
                    <label>RAM (GB)<input name="ramGB" type="number" min="1" step="1" value="${esc(p.ramGB)}"></label>
                    <label>VRAM (GB, optional)<input name="vramGB" type="number" min="0" step="1" value="${esc(p.vramGB || '')}"></label>
                    <label>CPU cores<input name="cpuCores" type="number" min="1" step="1" value="${esc(p.cpuCores)}"></label>
                    <label>GPU<input name="gpuName" value="${esc(p.gpuName)}"></label>
                    <label>Provider stack<input name="providerStack" value="${esc(p.providerStack || '')}"></label>
                    <div class="lm-actions"><button type="submit">Save override</button><button type="button" data-action="rescan">Rescan</button></div>
                </form>
                <div class="lm-card">
                    <h3>Top recommendations</h3>
                    <p class="lm-muted">Usable RAM estimate: ${rec.usableRamGB} GB · goal: ${esc(rec.useCase)}</p>
                    ${rec.recommended.slice(0,5).map(r => this.renderRecommendation(r)).join('') || '<p>No fitting model found. Try a remote profile.</p>'}
                </div>
            </div>`;
    }

    renderRecommendation(r) {
        return `<article class="lm-rec"><div><strong>${esc(r.model.name)}</strong><span>${esc(r.quant)} · ~${r.memoryGB} GB · score ${r.score}</span><small>${esc(r.reason)}</small></div><button data-action="choose" data-model="${r.model.id}" data-quant="${r.quant}">Use</button></article>`;
    }

    renderCatalog() {
        const rows = localModelCookbookService.getCatalog();
        return `<div class="lm-toolbar"><select data-action="usecase"><option>chat</option><option>coding</option><option>reasoning</option><option>research</option><option>vision</option><option>embeddings</option></select><select data-action="priority"><option>balanced</option><option>speed</option><option>quality</option></select></div>
        <div class="lm-catalog">${rows.map(m => `<article class="lm-card compact"><div class="lm-card-head"><h3>${esc(m.name)}</h3><button data-action="choose" data-model="${m.id}" data-quant="${m.quants[0]}">Select</button></div><p>${esc(m.notes)}</p><p class="lm-tags">${m.useCases.map(u => `<span>${esc(u)}</span>`).join('')} ${m.multimodal ? '<span>multimodal</span>' : ''}</p><p class="lm-muted">${m.paramsB}B params · ${m.contextK}K ctx · estimates: ${Object.entries(m.estimates).map(([q, g]) => `${q} ${g}GB`).join(', ')}</p></article>`).join('')}</div>`;
    }

    renderGuides() {
        const guides = localModelCookbookService.getProviderGuides(this.state.selectedModelId, this.state.selectedQuant);
        return `<div class="lm-card"><h3>Selected model</h3><p>${esc(guides[0].model.name)} · ${esc(this.state.selectedQuant)}</p></div><div class="lm-grid two">${guides.map(g => `<article class="lm-card"><h3>${esc(g.label)}</h3><p class="lm-muted">Base URL: ${esc(g.baseUrl)}</p><ol>${g.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol><pre><code>${esc(g.commandText)}</code></pre><div class="lm-actions"><button data-action="copy" data-text="${esc(g.commandText)}">Copy commands</button><button data-action="save-runbook" data-provider="${g.id}">Install later</button></div></article>`).join('')}</div><div class="lm-card"><h3>Saved install-later runbooks</h3>${this.state.runbooks.map(r => `<p><strong>${esc(r.modelName)}</strong> via ${esc(r.providerLabel)} · ${esc(r.status)} <button data-action="copy" data-text="${esc(r.command)}">Copy</button></p>`).join('') || '<p class="lm-muted">No runbooks yet.</p>'}</div>`;
    }

    renderRemote() {
        return `<div class="lm-grid two"><form class="lm-card" data-form="remote"><h3>Remote server profile</h3><label>Name<input name="name" placeholder="3090 box / Mac Studio"></label><label>Base URL<input name="baseUrl" placeholder="http://host:8000/v1"></label><label>Provider<input name="provider" value="openai-compatible"></label><label>Model name<input name="modelName" placeholder="qwen2.5-coder:32b"></label><label>Notes<textarea name="notes" rows="3"></textarea></label><button type="submit">Save remote profile</button></form><div class="lm-card"><h3>Saved remotes</h3>${this.state.remotes.map(r => `<article class="lm-rec"><div><strong>${esc(r.name)}</strong><span>${esc(r.modelName || 'No model set')} · ${esc(r.baseUrl)}</span><small>${esc(r.notes || '')}</small></div><button data-action="delete-remote" data-id="${r.id}">Delete</button></article>`).join('') || '<p class="lm-muted">No remote profiles saved.</p>'}</div></div>`;
    }

    renderBenchmarks() {
        return `<div class="lm-grid two"><form class="lm-card" data-form="benchmark"><h3>Record benchmark</h3><label>Model<select name="modelId">${localModelCookbookService.getCatalog().map(m => `<option value="${m.id}" ${m.id === this.state.selectedModelId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label><label>Provider<input name="provider" value="manual"></label><label>Quant<input name="quant" value="${esc(this.state.selectedQuant)}"></label><label>Output tokens<input name="outputTokens" type="number" min="0"></label><label>Elapsed ms<input name="elapsedMs" type="number" min="0"></label><label>Tokens/sec<input name="tokensPerSecond" type="number" min="0" step="0.1"></label><label>Notes<textarea name="notes" rows="3"></textarea></label><div class="lm-actions"><button type="submit">Save result</button><button type="button" data-action="live-benchmark">Run quick live test</button></div></form><div class="lm-card"><h3>Benchmark history</h3>${this.state.benchmarks.map(b => `<article class="lm-rec"><div><strong>${esc(b.modelName)}</strong><span>${esc(b.provider)} · ${esc(b.quant)} · ${b.tokensPerSecond || '?'} tok/s</span><small>${new Date(b.createdAt).toLocaleString()} · ${esc(b.notes || '')}</small></div></article>`).join('') || '<p class="lm-muted">No benchmarks yet.</p>'}</div></div>`;
    }

    bindEvents() {
        this.modal.querySelector('[data-action="close"]')?.addEventListener('click', () => this.close());
        this.modal.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => { this.state.tab = btn.dataset.tab; this.render(); }));
        this.modal.querySelectorAll('[data-action="choose"]').forEach(btn => btn.addEventListener('click', () => { this.state.selectedModelId = btn.dataset.model; this.state.selectedQuant = btn.dataset.quant; toast.success('Model selected for guides/benchmarks'); this.state.tab = 'guides'; this.render(); }));
        this.modal.querySelector('[data-action="rescan"]')?.addEventListener('click', async () => { this.state.settings = await localModelCookbookService.rescanProfile(); toast.success('Hardware profile rescanned'); this.render(); });
        this.modal.querySelectorAll('[data-action="copy"]').forEach(btn => btn.addEventListener('click', () => copyText(btn.dataset.text, 'Commands copied')));
        this.modal.querySelectorAll('[data-action="save-runbook"]').forEach(btn => btn.addEventListener('click', async () => { await localModelCookbookService.saveRunbook({ modelId: this.state.selectedModelId, quant: this.state.selectedQuant, provider: btn.dataset.provider }); await this.refreshLists(); toast.success('Saved to install-later runbooks'); this.render(); }));
        this.modal.querySelectorAll('[data-action="delete-remote"]').forEach(btn => btn.addEventListener('click', async () => { await localModelCookbookService.deleteRemoteProfile(btn.dataset.id); await this.refreshLists(); this.render(); }));
        this.modal.querySelector('[data-form="profile"]')?.addEventListener('submit', async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target).entries()); data.ramGB = Number(data.ramGB); data.vramGB = data.vramGB ? Number(data.vramGB) : null; data.cpuCores = Number(data.cpuCores); this.state.settings = await localModelCookbookService.updateProfile(data); toast.success('Hardware profile saved'); this.render(); });
        this.modal.querySelector('[data-form="remote"]')?.addEventListener('submit', async e => { e.preventDefault(); await localModelCookbookService.saveRemoteProfile(Object.fromEntries(new FormData(e.target).entries())); await this.refreshLists(); toast.success('Remote profile saved'); this.render(); });
        this.modal.querySelector('[data-form="benchmark"]')?.addEventListener('submit', async e => { e.preventDefault(); await localModelCookbookService.recordBenchmark(Object.fromEntries(new FormData(e.target).entries())); await this.refreshLists(); toast.success('Benchmark recorded'); this.render(); });
        this.modal.querySelector('[data-action="live-benchmark"]')?.addEventListener('click', async () => { try { toast.info('Running quick benchmark…'); await localModelCookbookService.runQuickBenchmark(this.state.selectedModelId); await this.refreshLists(); toast.success('Live benchmark recorded'); this.render(); } catch (error) { toast.error(`Benchmark failed: ${error.message}`); } });
    }
}

export function createLocalModelCookbookPanel() { return new LocalModelCookbookPanel(); }
export default LocalModelCookbookPanel;

/**
 * localModelCookbookService — hardware-aware local model setup assistant.
 * Local-first: stores settings, remote targets, deferred runbooks, and benchmark results in IndexedDB.
 */
import { getRecord, putRecord, getAllRecords, deleteRecord } from './idbStore.js';
import { providerManager } from './providerManager.js';

const SETTINGS_KEY = 'localModelCookbook';
const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const QUANT_BYTES_PER_B = { q4_K_M: 0.65, q4_K_S: 0.62, q5_K_M: 0.75, q6_K: 0.88, q8_0: 1.08, fp16: 2.05 };

export const MODEL_CATALOG = [
    { id: 'llama32-3b', name: 'Llama 3.2 3B Instruct', paramsB: 3.2, ollama: 'llama3.2:3b', hf: 'meta-llama/Llama-3.2-3B-Instruct', useCases: ['chat', 'writing', 'agent'], reasoning: 'light', multimodal: false, contextK: 128, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Excellent everyday assistant on low-memory machines.' },
    { id: 'qwen25-coder-7b', name: 'Qwen2.5 Coder 7B', paramsB: 7, ollama: 'qwen2.5-coder:7b', hf: 'Qwen/Qwen2.5-Coder-7B-Instruct', useCases: ['coding', 'agent'], reasoning: 'medium', multimodal: false, contextK: 32, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Strong code model with modest hardware needs.' },
    { id: 'mistral-nemo', name: 'Mistral Nemo 12B', paramsB: 12.2, ollama: 'mistral-nemo:12b', hf: 'mistralai/Mistral-Nemo-Instruct-2407', useCases: ['chat', 'writing', 'research'], reasoning: 'medium', multimodal: false, contextK: 128, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Balanced quality/speed on 16–32 GB RAM hosts.' },
    { id: 'llama31-8b', name: 'Llama 3.1 8B Instruct', paramsB: 8, ollama: 'llama3.1:8b', hf: 'meta-llama/Llama-3.1-8B-Instruct', useCases: ['chat', 'research'], reasoning: 'medium', multimodal: false, contextK: 128, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Reliable general local chat baseline.' },
    { id: 'gemma3-12b', name: 'Gemma 3 12B', paramsB: 12, ollama: 'gemma3:12b', hf: 'google/gemma-3-12b-it', useCases: ['chat', 'vision', 'writing'], reasoning: 'medium', multimodal: true, contextK: 128, quants: ['q4_K_M', 'q8_0', 'fp16'], notes: 'Good multimodal option when vision support matters.' },
    { id: 'qwen25-14b', name: 'Qwen2.5 14B Instruct', paramsB: 14, ollama: 'qwen2.5:14b', hf: 'Qwen/Qwen2.5-14B-Instruct', useCases: ['chat', 'research', 'coding'], reasoning: 'strong', multimodal: false, contextK: 32, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'High-quality fit for 24–32 GB machines.' },
    { id: 'deepseek-r1-14b', name: 'DeepSeek R1 Distill Qwen 14B', paramsB: 14, ollama: 'deepseek-r1:14b', hf: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B', useCases: ['reasoning', 'math', 'coding'], reasoning: 'strong', multimodal: false, contextK: 32, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Local reasoning pick; slower but better for step-by-step tasks.' },
    { id: 'llama31-70b', name: 'Llama 3.1 70B Instruct', paramsB: 70, ollama: 'llama3.1:70b', hf: 'meta-llama/Llama-3.1-70B-Instruct', useCases: ['research', 'writing', 'agent'], reasoning: 'strong', multimodal: false, contextK: 128, quants: ['q4_K_M', 'q5_K_M', 'q8_0'], notes: 'Remote/server-class target; best reserved for high RAM/VRAM hosts.' },
    { id: 'nomic-embed', name: 'Nomic Embed Text', paramsB: 0.14, ollama: 'nomic-embed-text', hf: 'nomic-ai/nomic-embed-text-v1.5', useCases: ['embeddings', 'rag'], reasoning: 'none', multimodal: false, contextK: 8, quants: ['q4_K_M', 'fp16'], notes: 'Good default embedding model for RAG.' }
];

export const PROVIDER_GUIDES = {
    ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434', steps: ['Install Ollama', 'Pull the recommended model', 'Run it once to warm cache', 'Choose Ollama in Synapse settings'], command: (m) => `ollama pull ${m.ollama || m.name}\nollama run ${m.ollama || m.name}` },
    lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234', steps: ['Install LM Studio', 'Search for the model/HF repo', 'Download a GGUF quant that fits memory', 'Start the local server', 'Use LM Studio provider in Synapse'], command: (m) => `Search LM Studio for: ${m.hf}\nLoad a ${m.quants[0]} GGUF and start server at http://localhost:1234` },
    llamacpp: { label: 'llama.cpp', baseUrl: 'http://localhost:8080', steps: ['Download or build llama.cpp', 'Download GGUF weights', 'Start llama-server', 'Point Synapse/OpenAI-compatible clients at the server'], command: (m, q = m.quants[0]) => `./llama-server -m ${m.id}.${q}.gguf -c ${m.contextK * 1024} --port 8080 --host 127.0.0.1` },
    vllm: { label: 'vLLM / remote GPU', baseUrl: 'http://remote-host:8000/v1', steps: ['Install vLLM on the GPU server', 'Serve the HF model', 'Protect the endpoint with auth/VPN', 'Add it as a remote profile'], command: (m) => `python -m pip install vllm\nvllm serve ${m.hf} --host 0.0.0.0 --port 8000 --max-model-len ${m.contextK * 1024}` },
    remote: { label: 'OpenAI-compatible remote', baseUrl: 'https://host.example/v1', steps: ['Create a remote server profile', 'Store base URL and model name', 'Keep API keys outside shared exports', 'Use the profile as a handoff/runbook target'], command: (m) => `curl ${'${BASE_URL}'}/chat/completions \\
  -H 'Authorization: Bearer ***' \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"${m.hf}","messages":[{"role":"user","content":"hello"}]}'` }
};

function estimateMemoryGB(model, quant = model.quants?.[0] || 'q4_K_M') {
    const weight = model.paramsB * (QUANT_BYTES_PER_B[quant] || 0.75);
    const context = Math.max(0.3, Math.min(4, model.contextK / 16));
    return Math.round((weight + context) * 10) / 10;
}

function detectGpu() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'Unknown GPU';
    } catch { return 'Unknown GPU'; }
}

class LocalModelCookbookService {
    constructor() { this.settings = null; }

    async init() { this.settings = await this.getSettings(); return this.settings; }

    scanHardware() {
        const memoryGB = navigator.deviceMemory || 8;
        const cores = navigator.hardwareConcurrency || 4;
        const platform = navigator.platform || 'Unknown OS';
        const gpuName = detectGpu();
        return { id: 'local', name: 'This browser host', hostType: 'local', os: platform, ramGB: memoryGB, cpuCores: cores, gpuName, vramGB: null, storageGB: null, providerStack: 'Ollama / LM Studio / llama.cpp', detectedAt: nowIso(), manual: false };
    }

    async getSettings() {
        const rec = await getRecord('settings', SETTINGS_KEY);
        if (rec?.value) return rec.value;
        const value = { key: SETTINGS_KEY, activeProfile: this.scanHardware(), preferences: { useCase: 'chat', priority: 'balanced', preferredProvider: 'ollama' }, history: [] };
        await this.saveSettings(value);
        return value;
    }

    async saveSettings(value) { this.settings = { ...value, updatedAt: nowIso() }; await putRecord('settings', { key: SETTINGS_KEY, value: this.settings, updatedAt: nowIso() }); return this.settings; }
    async updateProfile(patch) { const s = await this.getSettings(); s.activeProfile = { ...s.activeProfile, ...patch, manual: true, updatedAt: nowIso() }; s.history.unshift({ id: uid('hist'), action: 'profile-updated', createdAt: nowIso() }); return this.saveSettings(s); }
    async rescanProfile() { const s = await this.getSettings(); s.activeProfile = { ...s.activeProfile, ...this.scanHardware(), manual: false }; s.history.unshift({ id: uid('hist'), action: 'profile-scanned', createdAt: nowIso() }); return this.saveSettings(s); }
    getCatalog() { return MODEL_CATALOG.map(m => ({ ...m, estimates: Object.fromEntries(m.quants.map(q => [q, estimateMemoryGB(m, q)])) })); }

    recommend({ profile = null, useCase = null, priority = null } = {}) {
        const p = profile || this.settings?.activeProfile || this.scanHardware();
        const prefs = this.settings?.preferences || {};
        const goal = useCase || prefs.useCase || 'chat';
        const mode = priority || prefs.priority || 'balanced';
        const usableRam = Math.max(2, Number(p.ramGB || 8) - 2);
        const usableVram = Number(p.vramGB || 0);
        const rows = [];
        for (const model of MODEL_CATALOG) {
            for (const quant of model.quants) {
                const memoryGB = estimateMemoryGB(model, quant);
                const fitsRam = memoryGB <= usableRam;
                const fitsVram = usableVram ? memoryGB <= usableVram : false;
                const useCaseBonus = model.useCases.includes(goal) ? 18 : 0;
                const quality = Math.log2(model.paramsB + 1) * 10;
                const speed = 40 / Math.max(1, memoryGB);
                const fit = fitsRam ? 35 : -40;
                const gpu = fitsVram ? 10 : 0;
                const score = Math.round(fit + useCaseBonus + gpu + (mode === 'speed' ? speed * 2 : mode === 'quality' ? quality * 1.4 : quality + speed));
                rows.push({ model, quant, memoryGB, fitsRam, fitsVram, score, reason: fitsRam ? (fitsVram ? 'Fits RAM and VRAM/offload target.' : 'Fits system RAM; CPU or partial GPU offload likely.') : `Needs ~${memoryGB} GB; host has ~${usableRam} GB usable RAM.` });
            }
        }
        rows.sort((a, b) => b.score - a.score);
        return { generatedAt: nowIso(), profile: p, usableRamGB: usableRam, useCase: goal, priority: mode, recommended: rows.filter(r => r.fitsRam).slice(0, 12), stretch: rows.filter(r => !r.fitsRam).slice(0, 5), all: rows };
    }

    getProviderGuides(modelId, quant) {
        const model = MODEL_CATALOG.find(m => m.id === modelId) || MODEL_CATALOG[0];
        return Object.entries(PROVIDER_GUIDES).map(([id, guide]) => ({ id, ...guide, commandText: guide.command(model, quant), model }));
    }

    async listRemoteProfiles() { return (await getAllRecords('modelRemoteProfiles')).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')); }
    async saveRemoteProfile(profile) { const rec = { id: profile.id || uid('remote'), name: profile.name || 'Remote model server', provider: profile.provider || 'openai-compatible', baseUrl: profile.baseUrl || '', modelName: profile.modelName || '', notes: profile.notes || '', createdAt: profile.createdAt || nowIso(), updatedAt: nowIso() }; await putRecord('modelRemoteProfiles', rec); return rec; }
    async deleteRemoteProfile(id) { return deleteRecord('modelRemoteProfiles', id); }

    async listRunbooks() { return (await getAllRecords('modelRunbooks')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); }
    async saveRunbook({ modelId, quant, provider = 'ollama', status = 'pending' }) { const model = MODEL_CATALOG.find(m => m.id === modelId) || MODEL_CATALOG[0]; const guide = PROVIDER_GUIDES[provider] || PROVIDER_GUIDES.ollama; const rec = { id: uid('runbook'), modelId: model.id, modelName: model.name, quant: quant || model.quants[0], provider, providerLabel: guide.label, command: guide.command(model, quant || model.quants[0]), status, createdAt: nowIso(), updatedAt: nowIso() }; await putRecord('modelRunbooks', rec); return rec; }
    async updateRunbook(id, patch) { const old = await getRecord('modelRunbooks', id); const rec = { ...old, ...patch, updatedAt: nowIso() }; await putRecord('modelRunbooks', rec); return rec; }

    async listBenchmarks() { return (await getAllRecords('modelBenchmarks')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); }
    async recordBenchmark(record) { const model = MODEL_CATALOG.find(m => m.id === record.modelId); const rec = { id: record.id || uid('bench'), modelId: record.modelId, modelName: model?.name || record.modelName || 'Manual model', provider: record.provider || 'manual', quant: record.quant || model?.quants?.[0] || 'unknown', prompt: record.prompt || '', outputTokens: Number(record.outputTokens || 0), elapsedMs: Number(record.elapsedMs || 0), tokensPerSecond: Number(record.tokensPerSecond || 0), notes: record.notes || '', hardware: this.settings?.activeProfile || this.scanHardware(), createdAt: record.createdAt || nowIso() }; await putRecord('modelBenchmarks', rec); return rec; }
    async runQuickBenchmark(modelId, prompt = 'Write one short paragraph explaining why local AI is useful.') {
        const started = performance.now();
        const provider = providerManager.getProvider();
        const result = await provider.chat([{ role: 'user', content: prompt }], { temperature: 0.2, max_tokens: 160 });
        const elapsedMs = performance.now() - started;
        const outputTokens = result.evalCount || String(result.content || '').split(/\s+/).filter(Boolean).length;
        const tokensPerSecond = result.evalDuration ? outputTokens / (result.evalDuration / 1e9) : outputTokens / (elapsedMs / 1000);
        return this.recordBenchmark({ modelId, provider: providerManager.getProviderLabel(), prompt, outputTokens, elapsedMs: Math.round(elapsedMs), tokensPerSecond: Math.round(tokensPerSecond * 10) / 10, notes: 'Quick live benchmark from active Synapse provider.' });
    }
}

export const localModelCookbookService = new LocalModelCookbookService();
export default localModelCookbookService;

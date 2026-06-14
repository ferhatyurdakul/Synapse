import { getAllRecords, putRecord, deleteRecord } from './idbStore.js';
import { eventBus, Events } from '../utils/eventBus.js';

const BUILT_IN_SKILLS = [
    {
        id: 'builtin-deep-research-assistant',
        name: 'Deep Research Assistant',
        version: '1.0.0',
        origin: 'built-in',
        description: 'Turns broad questions into sourced research plans, evidence tables, and synthesis notes.',
        modes: ['research', 'document'],
        allowedTools: ['web_search', 'mcp'],
        requiredTools: ['web_search'],
        preferredModel: '',
        permissionExpectations: 'Can browse/search when web search is configured; asks before destructive actions.',
        executionHints: ['Start with a short plan', 'Track claims with source URLs', 'End with open questions and next searches'],
        prompt: 'You are operating in Deep Research Assistant mode. Break the question into research subquestions, gather or request sources, separate evidence from inference, and produce a concise synthesis with citations when sources are available.',
        starterInputs: [
            'Create a research plan for this question, including search queries and evidence I should gather:',
            'Turn these notes into a sourced research brief with claims, evidence, and gaps:'
        ]
    },
    {
        id: 'builtin-coding-reviewer',
        name: 'Coding Reviewer',
        version: '1.0.0',
        origin: 'built-in',
        description: 'Reviews code changes for correctness, security, maintainability, and missing tests.',
        modes: ['agent', 'chat', 'compare'],
        allowedTools: ['builtin', 'backend', 'mcp'],
        requiredTools: ['builtin'],
        preferredModel: '',
        permissionExpectations: 'Read-first review; proposes patches separately unless explicitly asked to edit.',
        executionHints: ['Prioritize concrete bugs over style', 'Call out test gaps', 'Include file/area references'],
        prompt: 'You are operating as a senior coding reviewer. Look for correctness bugs, security issues, race conditions, regressions, and missing tests. Be specific and actionable; avoid vague style comments unless they affect maintainability.',
        starterInputs: [
            'Review this change for bugs, security issues, and missing tests:',
            'Compare these two implementation approaches and recommend the safer one:'
        ]
    },
    {
        id: 'builtin-document-summarizer',
        name: 'Document Summarizer',
        version: '1.0.0',
        origin: 'built-in',
        description: 'Extracts structure, key points, action items, and reusable notes from documents.',
        modes: ['document', 'chat'],
        allowedTools: ['builtin'],
        requiredTools: [],
        preferredModel: '',
        permissionExpectations: 'Works from attached or pasted source material; flags missing context.',
        executionHints: ['Preserve terminology', 'Separate summary from action items', 'Quote important source lines when useful'],
        prompt: 'You are operating as a document summarizer. Preserve the author\'s intent, extract the main ideas, identify action items, and clearly label uncertainty or missing context.',
        starterInputs: [
            'Summarize this document into key points, decisions, and action items:',
            'Extract reusable notes, definitions, and follow-up questions from this source:'
        ]
    }
];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeSkill(raw, fallbackOrigin = 'user') {
    const now = new Date().toISOString();
    const id = raw.id || `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        id,
        name: String(raw.name || 'Untitled Skill').trim(),
        version: String(raw.version || '1.0.0').trim(),
        origin: raw.origin || fallbackOrigin,
        description: String(raw.description || '').trim(),
        modes: normalizeList(raw.modes),
        allowedTools: normalizeList(raw.allowedTools),
        requiredTools: normalizeList(raw.requiredTools),
        preferredModel: String(raw.preferredModel || '').trim(),
        permissionExpectations: String(raw.permissionExpectations || '').trim(),
        executionHints: normalizeList(raw.executionHints),
        prompt: String(raw.prompt || '').trim(),
        starterInputs: normalizeList(raw.starterInputs),
        createdAt: raw.createdAt || now,
        updatedAt: now
    };
}

class SkillService {
    constructor() {
        this.skills = new Map();
        this.ready = false;
    }

    async init() {
        this.skills.clear();
        BUILT_IN_SKILLS.forEach(skill => this.skills.set(skill.id, normalizeSkill(skill, 'built-in')));
        const userSkills = await getAllRecords('skills');
        userSkills.forEach(skill => this.skills.set(skill.id, normalizeSkill(skill, skill.origin || 'user')));
        this.ready = true;
    }

    getAllSkills() {
        return [...this.skills.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name));
    }

    getSkill(id) {
        const skill = this.skills.get(id);
        return skill ? clone(skill) : null;
    }

    getSkillsForMode(mode) {
        return this.getAllSkills().filter(skill => skill.modes.length === 0 || skill.modes.includes(mode));
    }

    getActiveSkills(chat) {
        const ids = Array.isArray(chat?.activeSkillIds) ? chat.activeSkillIds : [];
        return ids.map(id => this.skills.get(id)).filter(Boolean).map(clone);
    }

    async saveSkill(skill) {
        const normalized = normalizeSkill(skill, skill.origin || 'user');
        normalized.origin = normalized.origin === 'built-in' ? 'user' : normalized.origin;
        this.skills.set(normalized.id, normalized);
        await putRecord('skills', normalized);
        eventBus.emit(Events.SKILLS_UPDATED, { skill: clone(normalized) });
        return clone(normalized);
    }

    async deleteSkill(id) {
        const skill = this.skills.get(id);
        if (!skill || skill.origin === 'built-in') return false;
        this.skills.delete(id);
        await deleteRecord('skills', id);
        eventBus.emit(Events.SKILLS_UPDATED, { deletedId: id });
        return true;
    }

    buildSystemPrompt(basePrompt = '', activeSkillIds = []) {
        const active = activeSkillIds.map(id => this.skills.get(id)).filter(Boolean);
        if (active.length === 0) return basePrompt || '';
        const skillBlocks = active.map(skill => {
            const hints = skill.executionHints.length ? `\nExecution hints:\n${skill.executionHints.map(h => `- ${h}`).join('\n')}` : '';
            const tools = skill.requiredTools.length ? `\nRequired tools: ${skill.requiredTools.join(', ')}` : '';
            const permissions = skill.permissionExpectations ? `\nPermission expectations: ${skill.permissionExpectations}` : '';
            const model = skill.preferredModel ? `\nPreferred model: ${skill.preferredModel}` : '';
            return `Skill: ${skill.name} v${skill.version}\n${skill.prompt}${hints}${tools}${permissions}${model}`;
        }).join('\n\n---\n\n');
        return [basePrompt, `Active Synapse skill/workflow instructions:\n\n${skillBlocks}`].filter(Boolean).join('\n\n');
    }

    getToolCategories(activeSkillIds = [], fallbackCategories = []) {
        const active = activeSkillIds.map(id => this.skills.get(id)).filter(Boolean);
        const declared = new Set();
        active.forEach(skill => {
            skill.allowedTools.forEach(tool => declared.add(tool));
            skill.requiredTools.forEach(tool => declared.add(tool));
        });
        if (declared.size === 0) return fallbackCategories;
        const fallback = new Set(fallbackCategories);
        return [...declared].filter(tool => fallback.has(tool));
    }

    getInjectionSummary(chat) {
        const active = this.getActiveSkills(chat);
        return active.map(skill => ({
            id: skill.id,
            name: skill.name,
            version: skill.version,
            origin: skill.origin,
            promptChars: skill.prompt.length,
            allowedTools: skill.allowedTools,
            requiredTools: skill.requiredTools,
            preferredModel: skill.preferredModel,
            starterInputs: skill.starterInputs
        }));
    }

    exportSkills(ids = null) {
        const selected = ids?.length ? ids.map(id => this.skills.get(id)).filter(Boolean) : this.getAllSkills();
        const exportable = selected.filter(skill => skill.origin !== 'built-in').map(clone);
        return JSON.stringify({ schema: 'synapse.skills.v1', exportedAt: new Date().toISOString(), skills: exportable }, null, 2);
    }

    async importSkills(jsonString) {
        const parsed = JSON.parse(jsonString);
        const incoming = Array.isArray(parsed) ? parsed : parsed.skills;
        if (!Array.isArray(incoming)) throw new Error('No skills array found in import file.');
        const saved = [];
        for (const item of incoming) {
            saved.push(await this.saveSkill({ ...item, origin: 'user' }));
        }
        eventBus.emit(Events.SKILLS_IMPORTED, { skills: saved });
        return saved;
    }
}

export const skillService = new SkillService();

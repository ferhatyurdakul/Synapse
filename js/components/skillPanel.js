import { chatService } from '../services/chatService.js';
import { skillService } from '../services/skillService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { toast } from './toast.js';

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

class SkillPanel {
    constructor() {
        this.isOpen = false;
        this.dialog = null;
        this.fileInput = null;
        this.renderTrigger();
        this.listenToEvents();
    }

    renderTrigger() {
        const statusInfo = document.querySelector('.status-info');
        if (!statusInfo || document.getElementById('skills-btn')) return;
        const button = document.createElement('button');
        button.id = 'skills-btn';
        button.className = 'status-action-btn';
        button.type = 'button';
        button.title = 'Attach skills and reusable workflows';
        button.setAttribute('aria-label', 'Open skills and workflows');
        button.innerHTML = '<i data-lucide="sparkles" class="icon"></i><span>Skills</span>';
        const version = statusInfo.querySelector('span:last-child');
        statusInfo.insertBefore(button, version);
        button.addEventListener('click', () => this.open());
        refreshIcons();
    }

    listenToEvents() {
        [Events.CHAT_SELECTED, Events.CHAT_CREATED, Events.CHAT_UPDATED, Events.SESSION_MODE_CHANGED, Events.SKILLS_UPDATED].forEach(eventName => {
            eventBus.on(eventName, () => {
                this.updateTriggerBadge();
                if (this.isOpen) this.renderModalBody();
            });
        });
    }

    updateTriggerBadge() {
        const button = document.getElementById('skills-btn');
        if (!button) return;
        const count = skillService.getActiveSkills(chatService.getCurrentChat()).length;
        button.classList.toggle('active', count > 0);
        button.title = count > 0 ? `${count} active skill${count === 1 ? '' : 's'} attached` : 'Attach skills and reusable workflows';
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        this.dialog = document.createElement('div');
        this.dialog.id = 'skills-modal';
        this.dialog.className = 'skills-modal';
        this.dialog.innerHTML = `
            <div class="skills-overlay"></div>
            <div class="skills-panel" role="dialog" aria-modal="true" aria-label="Skills and reusable workflows">
                <header class="skills-header">
                    <div>
                        <p class="skills-eyebrow">Reusable workflows</p>
                        <h2><i data-lucide="sparkles" class="icon"></i> Skills</h2>
                    </div>
                    <button id="skills-close-btn" class="settings-close-btn" title="Close" aria-label="Close"><i data-lucide="x" class="icon"></i></button>
                </header>
                <div id="skills-modal-body"></div>
            </div>
        `;
        document.body.appendChild(this.dialog);
        this.dialog.querySelector('.skills-overlay').addEventListener('click', () => this.close());
        this.dialog.querySelector('#skills-close-btn').addEventListener('click', () => this.close());
        this.dialog.addEventListener('click', (event) => this.handleClick(event));
        document.addEventListener('keydown', this.onKeyDown);
        this.renderModalBody();
        refreshIcons();
    }

    onKeyDown = (event) => {
        if (event.key === 'Escape' && this.isOpen) this.close();
    };

    close() {
        document.removeEventListener('keydown', this.onKeyDown);
        this.dialog?.remove();
        this.dialog = null;
        this.isOpen = false;
    }

    ensureChat() {
        let chat = chatService.getCurrentChat();
        if (!chat) {
            const id = chatService.createChat({ title: 'New Chat', mode: chatService.getCurrentMode() });
            chat = chatService.getChat(id);
        }
        return chat;
    }

    renderModalBody() {
        const body = document.getElementById('skills-modal-body');
        if (!body) return;
        const mode = chatService.getCurrentMode();
        const chat = chatService.getCurrentChat();
        const activeIds = new Set(chat?.activeSkillIds || []);
        const skills = skillService.getSkillsForMode(mode);
        const injection = skillService.getInjectionSummary(chat);

        body.innerHTML = `
            <section class="skills-section skills-current">
                <div>
                    <h3>Current workspace: ${escapeHtml(mode)}</h3>
                    <p>Attach skills to augment the system prompt, starter inputs, tool bundle, model hints, and execution expectations for this session.</p>
                </div>
                <div class="skills-actions">
                    <button class="settings-btn secondary" data-action="import-skills">Import</button>
                    <button class="settings-btn secondary" data-action="export-skills">Export User Skills</button>
                </div>
            </section>
            <section class="skills-grid">
                ${skills.map(skill => this.renderSkillCard(skill, activeIds.has(skill.id))).join('')}
            </section>
            <section class="skills-section">
                <h3>Review / Debug Injection</h3>
                ${injection.length === 0 ? '<p class="skills-muted">No active skills. The base system prompt and workspace mode are unchanged.</p>' : `
                    <div class="skill-debug-list">
                        ${injection.map(item => `
                            <article class="skill-debug-card">
                                <strong>${escapeHtml(item.name)} <span>v${escapeHtml(item.version)}</span></strong>
                                <p>${item.promptChars} prompt chars injected · tools: ${escapeHtml([...new Set([...item.allowedTools, ...item.requiredTools])].join(', ') || 'default')}</p>
                                ${item.preferredModel ? `<p>Preferred model: ${escapeHtml(item.preferredModel)}</p>` : ''}
                            </article>
                        `).join('')}
                    </div>
                `}
            </section>
            <input type="file" id="skills-import-input" accept="application/json,.json" class="hidden">
        `;
        this.fileInput = body.querySelector('#skills-import-input');
        this.fileInput?.addEventListener('change', (event) => this.importFromFile(event));
        refreshIcons();
    }

    renderSkillCard(skill, active) {
        const tools = [...new Set([...skill.allowedTools, ...skill.requiredTools])];
        return `
            <article class="skill-card ${active ? 'active' : ''}" data-skill-id="${escapeHtml(skill.id)}">
                <div class="skill-card-header">
                    <div>
                        <p class="skill-origin">${escapeHtml(skill.origin)} · v${escapeHtml(skill.version)}</p>
                        <h3>${escapeHtml(skill.name)}</h3>
                    </div>
                    <label class="settings-toggle" title="Attach skill">
                        <input type="checkbox" data-action="toggle-skill" ${active ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <p>${escapeHtml(skill.description)}</p>
                <div class="skill-meta">
                    ${skill.modes.map(mode => `<span>${escapeHtml(mode)}</span>`).join('')}
                    ${tools.map(tool => `<span>${escapeHtml(tool)}</span>`).join('')}
                    ${skill.preferredModel ? `<span>${escapeHtml(skill.preferredModel)}</span>` : ''}
                </div>
                ${skill.starterInputs.length ? `
                    <div class="skill-starters">
                        ${skill.starterInputs.map((starter, index) => `
                            <button class="skill-starter" data-action="insert-starter" data-index="${index}">${escapeHtml(starter)}</button>
                        `).join('')}
                    </div>
                ` : ''}
            </article>
        `;
    }

    handleClick(event) {
        const actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        if (action === 'toggle-skill') {
            const card = actionEl.closest('.skill-card');
            this.toggleSkill(card?.dataset.skillId, actionEl.checked);
        } else if (action === 'insert-starter') {
            const card = actionEl.closest('.skill-card');
            const skill = skillService.getSkill(card?.dataset.skillId);
            const starter = skill?.starterInputs?.[Number(actionEl.dataset.index)];
            this.insertStarter(starter);
        } else if (action === 'export-skills') {
            this.exportSkills();
        } else if (action === 'import-skills') {
            this.fileInput?.click();
        }
    }

    toggleSkill(skillId, enabled) {
        const chat = this.ensureChat();
        const ids = new Set(chat.activeSkillIds || []);
        if (enabled) ids.add(skillId);
        else ids.delete(skillId);
        chatService.updateSkills(chat.id, [...ids]);
        toast.success(enabled ? 'Skill attached to this session.' : 'Skill removed from this session.');
    }

    insertStarter(starter) {
        if (!starter) return;
        const input = document.getElementById('message-input');
        if (!input) return;
        input.value = input.value ? `${input.value.trim()}\n\n${starter}` : starter;
        input.dispatchEvent(new Event('input'));
        input.focus();
        this.close();
    }

    exportSkills() {
        const blob = new Blob([skillService.exportSkills()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `synapse-skills-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
    }

    async importFromFile(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const imported = await skillService.importSkills(text);
            toast.success(`Imported ${imported.length} skill${imported.length === 1 ? '' : 's'}.`);
        } catch (error) {
            toast.error(`Skill import failed: ${error.message}`);
        } finally {
            event.target.value = '';
        }
    }
}

export function createSkillPanel() {
    return new SkillPanel();
}

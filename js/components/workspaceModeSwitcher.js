import { chatService } from '../services/chatService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { getSessionModes, getSessionModeConfig } from '../config/sessionModes.js';

class WorkspaceModeSwitcher {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.dialogId = 'mode-transition-dialog';
        this.init();
    }

    init() {
        this.render();
        this.attachEvents();
        this.listenToEvents();
    }

    render() {
        const currentMode = chatService.getCurrentMode();
        const config = getSessionModeConfig(currentMode);
        const modes = getSessionModes();

        this.container.innerHTML = `
            <div class="workspace-mode-switcher">
                <div class="workspace-mode-pills" role="tablist" aria-label="Workspace modes">
                    ${modes.map(mode => `
                        <button
                            class="workspace-mode-pill ${mode.id === currentMode ? 'active' : ''}"
                            data-mode="${mode.id}"
                            role="tab"
                            aria-selected="${mode.id === currentMode ? 'true' : 'false'}"
                            title="${mode.description}"
                        >
                            <i data-lucide="${mode.icon}" class="icon"></i>
                            <span>${mode.shortLabel}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="workspace-mode-summary">
                    <span class="workspace-mode-current">
                        <i data-lucide="${config.icon}" class="icon"></i>
                        ${config.label}
                    </span>
                    <span class="workspace-mode-description">${config.description}</span>
                </div>
            </div>
        `;

        refreshIcons();
    }

    attachEvents() {
        this.container.addEventListener('click', async (e) => {
            const button = e.target.closest('.workspace-mode-pill');
            if (!button) return;
            const targetMode = button.dataset.mode;
            const currentChat = chatService.getCurrentChat();

            if (!currentChat || currentChat.mode === targetMode) {
                chatService.setCurrentMode(targetMode);
                return;
            }

            const action = await this.showModeTransitionDialog(currentChat.mode, targetMode);
            if (action === 'branch') {
                await chatService.branchChatToMode(currentChat.id, targetMode);
                return;
            }

            if (action === 'convert') {
                chatService.convertChatToMode(currentChat.id, targetMode);
            }
        });
    }

    listenToEvents() {
        eventBus.on(Events.SESSION_MODE_CHANGED, () => this.render());
        eventBus.on(Events.CHAT_SELECTED, () => this.render());
        eventBus.on(Events.CHAT_CREATED, () => this.render());
    }

    showModeTransitionDialog(sourceMode, targetMode) {
        const existing = document.getElementById(this.dialogId);
        if (existing) existing.remove();

        const sourceConfig = getSessionModeConfig(sourceMode);
        const targetConfig = getSessionModeConfig(targetMode);
        const dialog = document.createElement('div');
        dialog.id = this.dialogId;
        dialog.className = 'confirm-dialog';
        dialog.innerHTML = `
            <div class="confirm-overlay"></div>
            <div class="confirm-panel mode-transition-panel">
                <h3 class="confirm-title">Move this session into ${targetConfig.label}?</h3>
                <p class="confirm-message">
                    This ${sourceConfig.label.toLowerCase()} session will stay available. You can either branch a new
                    ${targetConfig.label.toLowerCase()} session with the same history, or convert this session in place.
                </p>
                <div class="mode-transition-summary">
                    <span class="mode-transition-badge">${sourceConfig.shortLabel}</span>
                    <i data-lucide="arrow-right" class="icon"></i>
                    <span class="mode-transition-badge">${targetConfig.shortLabel}</span>
                </div>
                <div class="confirm-actions mode-transition-actions">
                    <button class="confirm-btn cancel" data-action="cancel">Cancel</button>
                    <button class="confirm-btn" data-action="convert">Convert This Session</button>
                    <button class="confirm-btn primary" data-action="branch">Branch to ${targetConfig.label}</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        refreshIcons();

        return new Promise((resolve) => {
            const close = (action = 'cancel') => {
                document.removeEventListener('keydown', onKey);
                dialog.remove();
                resolve(action);
            };
            const onKey = (event) => {
                if (event.key === 'Escape') {
                    close();
                }
            };

            document.addEventListener('keydown', onKey);
            dialog.querySelector('.confirm-overlay').addEventListener('click', () => close());
            dialog.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', () => close(btn.dataset.action));
            });
            dialog.querySelector('[data-action="branch"]').focus();
        });
    }
}

export function createWorkspaceModeSwitcher(containerId) {
    return new WorkspaceModeSwitcher(containerId);
}

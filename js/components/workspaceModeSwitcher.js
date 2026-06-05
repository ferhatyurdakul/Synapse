import { chatService } from '../services/chatService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { getSessionModes, getSessionModeConfig } from '../config/sessionModes.js';

class WorkspaceModeSwitcher {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
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
        this.container.addEventListener('click', (e) => {
            const button = e.target.closest('.workspace-mode-pill');
            if (!button) return;
            chatService.setCurrentMode(button.dataset.mode);
        });
    }

    listenToEvents() {
        eventBus.on(Events.SESSION_MODE_CHANGED, () => this.render());
        eventBus.on(Events.CHAT_SELECTED, () => this.render());
        eventBus.on(Events.CHAT_CREATED, () => this.render());
    }
}

export function createWorkspaceModeSwitcher(containerId) {
    return new WorkspaceModeSwitcher(containerId);
}

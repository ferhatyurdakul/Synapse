/**
 * App - Main application controller
 * Initializes and coordinates all components
 */

import { createModelSelector } from './components/modelSelector.js?v=27';
import { createChatSidebar } from './components/chatSidebar.js?v=27';
import { createChatView } from './components/chatView.js?v=27';
import { createInputArea } from './components/inputArea.js?v=27';
import { createSettingsPanel } from './components/settingsPanel.js?v=27';
import { createContextMeter } from './components/contextMeter.js?v=27';
import { providerManager } from './services/providerManager.js?v=27';
import { eventBus, Events } from './utils/eventBus.js?v=27';

class App {
    constructor() {
        this.modelSelector = null;
        this.chatSidebar = null;
        this.chatView = null;
        this.inputArea = null;
    }

    async init() {
        console.log('Initializing Synapse...');

        // Check connectivity for active provider
        await this.checkProviderConnection();

        // Initialize components
        this.modelSelector = createModelSelector('model-selector-container');
        this.chatSidebar = createChatSidebar('sidebar-container');
        this.chatView = createChatView('chat-view-container');
        this.inputArea = createInputArea('input-area-container');
        this.contextMeter = createContextMeter();
        this.settingsPanel = createSettingsPanel();

        // Set up global event listeners
        this.setupGlobalEvents();

        console.log('Synapse initialized successfully');
    }

    async checkProviderConnection() {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        const provider = providerManager.getProvider();
        const label = providerManager.getProviderLabel();

        const isAvailable = await provider.isServerAvailable();

        if (isAvailable) {
            statusDot?.classList.remove('offline');
            if (statusText) statusText.textContent = `Connected to ${label}`;
        } else {
            statusDot?.classList.add('offline');
            if (statusText) statusText.textContent = `${label} not connected`;
            console.warn(`${label} server is not available.`);
        }
    }

    setupGlobalEvents() {
        // Periodically check provider connection
        setInterval(() => this.checkProviderConnection(), 30000);

        // Handle visibility change to refresh connection
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.checkProviderConnection();
            }
        });

        // Provider change - re-check connection
        eventBus.on(Events.PROVIDER_CHANGED, () => {
            this.checkProviderConnection();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + N for new chat
            if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
                e.preventDefault();
                document.getElementById('new-chat-btn')?.click();
            }

            // Escape to stop generation
            if (e.key === 'Escape') {
                const stopBtn = document.getElementById('stop-btn');
                if (stopBtn && !stopBtn.classList.contains('hidden')) {
                    stopBtn.click();
                }
            }
        });
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init().catch(console.error);
});

export default App;

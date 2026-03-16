/**
 * App - Main application controller
 * Initializes and coordinates all components
 */

import { createModelSelector } from './components/modelSelector.js?v=34';
import { createChatSidebar } from './components/chatSidebar.js?v=34';
import { createChatView } from './components/chatView.js?v=34';
import { createInputArea } from './components/inputArea.js?v=34';
import { createSettingsPanel } from './components/settingsPanel.js?v=34';
import { createContextMeter } from './components/contextMeter.js?v=34';
import { providerManager } from './services/providerManager.js?v=34';
import { eventBus, Events } from './utils/eventBus.js?v=34';
import { toast } from './components/toast.js?v=34';
import './tools/builtins.js?v=34'; // registers built-in tools into toolRegistry

class App {
    constructor() {
        this.modelSelector = null;
        this.chatSidebar = null;
        this.chatView = null;
        this.inputArea = null;
        this._providerOnline = null; // null = unknown (initial state)
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
            if (this._providerOnline === false) {
                toast.success(`Reconnected to ${label}`);
            }
            this._providerOnline = true;
        } else {
            statusDot?.classList.add('offline');
            if (statusText) statusText.textContent = `${label} not connected`;
            if (this._providerOnline !== false) {
                toast.warning(`${label} is not connected`);
            }
            this._providerOnline = false;
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

        // Provider change - reset state so the next check always toasts if offline
        eventBus.on(Events.PROVIDER_CHANGED, () => {
            this._providerOnline = null;
            this.checkProviderConnection();
        });

        // Storage quota exceeded
        window.addEventListener('synapse:quotaExceeded', () => {
            toast.error('Storage full. Export your chats and delete old ones to free space.');
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

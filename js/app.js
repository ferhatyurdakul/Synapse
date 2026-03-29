/**
 * App - Main application controller
 * Initializes and coordinates all components
 */

import { createModelSelector } from './components/modelSelector.js?v=36';
import { createChatSidebar } from './components/chatSidebar.js?v=37';
import { createChatView } from './components/chatView.js?v=36';
import { createInputArea } from './components/inputArea.js?v=36';
import { createSettingsPanel } from './components/settingsPanel.js?v=37';
import { createContextMeter } from './components/contextMeter.js?v=36';
import { storageService } from './services/storageService.js?v=36';
import { chatService } from './services/chatService.js?v=36';
import { providerManager } from './services/providerManager.js?v=36';
import { eventBus, Events } from './utils/eventBus.js?v=36';
import { toast } from './components/toast.js?v=36';
import { themeService } from './services/themeService.js?v=36';
import './tools/builtins.js?v=36'; // registers built-in tools into toolRegistry
import './tools/webSearch.js?v=36'; // registers web search tool

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

        // Initialize storage (IndexedDB + migration from localStorage)
        await storageService.init();
        providerManager.reload(); // re-read saved provider settings from IDB cache
        themeService.applyTheme();
        await chatService.load();

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

        // Render any static Lucide icons (e.g. hamburger button)
        refreshIcons();

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

        // Settings updated (e.g. provider URLs changed) - re-check connection
        eventBus.on(Events.SETTINGS_UPDATED, () => {
            this._providerOnline = null;
            this.checkProviderConnection();
        });

        // Storage quota exceeded
        window.addEventListener('synapse:quotaExceeded', () => {
            toast.error('Storage full. Export your chats and delete old ones to free space.');
        });

        // Storage migration failure
        window.addEventListener('synapse:migrationFailed', () => {
            toast.error('Failed to migrate data to IndexedDB. Some data may be unavailable.');
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to stop generation or close mobile sidebar
            if (e.key === 'Escape') {
                if (this.closeMobileSidebar()) return;
                const stopBtn = document.getElementById('stop-btn');
                if (stopBtn && !stopBtn.classList.contains('hidden')) {
                    stopBtn.click();
                }
            }
        });

        // Mobile hamburger menu
        this.setupMobileSidebar();
    }

    setupMobileSidebar() {
        const hamburger = document.getElementById('hamburger-btn');
        const sidebar = document.getElementById('sidebar-container');
        const overlay = document.getElementById('sidebar-overlay');

        hamburger.addEventListener('click', () => {
            sidebar.classList.add('mobile-open');
            overlay.classList.add('active');
        });

        overlay.addEventListener('click', () => {
            this.closeMobileSidebar();
        });

        // Close sidebar when a chat is selected on mobile
        eventBus.on(Events.CHAT_SELECTED, () => {
            this.closeMobileSidebar();
        });

        eventBus.on(Events.CHAT_CREATED, () => {
            this.closeMobileSidebar();
        });
    }

    closeMobileSidebar() {
        const sidebar = document.getElementById('sidebar-container');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar.classList.contains('mobile-open')) {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
            return true;
        }
        return false;
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init().catch(console.error);
});

export default App;

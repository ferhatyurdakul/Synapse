/**
 * App - Main application controller
 * Initializes and coordinates all components
 */

import { createModelSelector } from './components/modelSelector.js?v=25';
import { createChatSidebar } from './components/chatSidebar.js?v=25';
import { createChatView } from './components/chatView.js?v=25';
import { createInputArea } from './components/inputArea.js?v=25';
import { createSettingsPanel } from './components/settingsPanel.js?v=25';
import { createContextMeter } from './components/contextMeter.js?v=25';
import { ollamaService } from './services/ollamaService.js?v=25';
import { eventBus, Events } from './utils/eventBus.js?v=25';

class App {
    constructor() {
        this.modelSelector = null;
        this.chatSidebar = null;
        this.chatView = null;
        this.inputArea = null;
    }

    async init() {
        console.log('Initializing Synapse...');

        // Check Ollama connectivity
        await this.checkOllamaConnection();

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

    async checkOllamaConnection() {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');

        const isAvailable = await ollamaService.isServerAvailable();

        if (isAvailable) {
            statusDot?.classList.remove('offline');
            if (statusText) statusText.textContent = 'Connected to Ollama';
        } else {
            statusDot?.classList.add('offline');
            if (statusText) statusText.textContent = 'Ollama not connected';
            console.warn('Ollama server is not available. Please ensure Ollama is running.');
        }
    }

    setupGlobalEvents() {
        // Periodically check Ollama connection
        setInterval(() => this.checkOllamaConnection(), 30000);

        // Handle visibility change to refresh connection
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                this.checkOllamaConnection();
            }
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

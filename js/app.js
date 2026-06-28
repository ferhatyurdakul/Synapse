/**
 * App - Main application controller
 * Initializes and coordinates all components
 */

import { createModelSelector } from './components/modelSelector.js';
import { createChatSidebar } from './components/chatSidebar.js';
import { createChatView } from './components/chatView.js';
import { createInputArea } from './components/inputArea.js';
import { createSettingsPanel } from './components/settingsPanel.js';
import { createDiagnosticsPanel } from './components/diagnosticsPanel.js';
import { createMCPRegistryPanel } from './components/mcpRegistryPanel.js';
import { createMemoryPanel } from './components/memoryPanel.js';
import { createSkillPanel } from './components/skillPanel.js';
import { createDocumentWorkspace } from './components/documentWorkspace.js';
import { createResearchReportsPanel } from './components/researchReportsPanel.js';
import { createNotesTasksPanel } from './components/notesTasksPanel.js';
import { createComparePanel } from './components/comparePanel.js';
import { createContactsPanel } from './components/contactsPanel.js';
import { createImageGalleryPanel } from './components/imageGalleryPanel.js';
import { createCalendarPanel } from './components/calendarPanel.js';
import { createEmailPanel } from './components/emailPanel.js';
import { createBackupPanel } from './components/backupPanel.js';
import { createContextMeter } from './components/contextMeter.js';
import { createWorkspaceModeSwitcher } from './components/workspaceModeSwitcher.js';
import { storageService } from './services/storageService.js';
import { chatService } from './services/chatService.js';
import { agentRunService } from './services/agentRunService.js';
import { mcpService } from './services/mcpService.js';
import { memoryService } from './services/memoryService.js';
import { skillService } from './services/skillService.js';
import { providerManager } from './services/providerManager.js';
import { eventBus, Events } from './utils/eventBus.js';
import { toast } from './components/toast.js';
import { themeService } from './services/themeService.js';
import { calendarService } from './services/calendarService.js';
import { emailService } from './services/emailService.js';
import './tools/builtins.js'; // registers built-in tools into toolRegistry
import './tools/webSearch.js'; // registers web search tool
import './tools/backendTools.js'; // registers backend tool runner tools

class App {
    constructor() {
        this.modelSelector = null;
        this.chatSidebar = null;
        this.chatView = null;
        this.inputArea = null;
        this.diagnosticsPanel = null;
        this.memoryPanel = null;
        this.skillPanel = null;
        this.documentWorkspace = null;
        this.researchReportsPanel = null;
        this.notesTasksPanel = null;
        this.comparePanel = null;
        this.contactsPanel = null;
        this.imageGalleryPanel = null;
        this.calendarPanel = null;
        this.emailPanel = null;
        this.backupPanel = null;
        this.workspaceModeSwitcher = null;
        this._providerOnline = null; // null = unknown (initial state)
    }

    async init() {
        console.log('Initializing Synapse...');

        // Initialize storage (IndexedDB + migration from localStorage)
        await storageService.init();
        providerManager.reload(); // re-read saved provider settings from IDB cache
        themeService.applyTheme();
        await chatService.load();
        await agentRunService.load();
        await mcpService.load();
        await memoryService.init();
        await skillService.init();
        await calendarService.init();
        await emailService.init();

        // Check connectivity for active provider
        await this.checkProviderConnection();

        // Initialize components
        this.modelSelector = createModelSelector('model-selector-container');
        this.chatSidebar = createChatSidebar('sidebar-container');
        this.chatView = createChatView('chat-view-container');
        this.inputArea = createInputArea('input-area-container');
        this.contextMeter = createContextMeter();
        this.workspaceModeSwitcher = createWorkspaceModeSwitcher('workspace-mode-container');
        this.settingsPanel = createSettingsPanel();
        this.mcpRegistryPanel = createMCPRegistryPanel();
        this.memoryPanel = createMemoryPanel();
        this.skillPanel = createSkillPanel();
        this.documentWorkspace = createDocumentWorkspace();
        this.researchReportsPanel = createResearchReportsPanel();
        this.notesTasksPanel = createNotesTasksPanel();
        this.comparePanel = createComparePanel();
        this.contactsPanel = createContactsPanel();
        this.imageGalleryPanel = createImageGalleryPanel();
        this.calendarPanel = createCalendarPanel();
        this.emailPanel = createEmailPanel();
        this.backupPanel = createBackupPanel();
        this.diagnosticsPanel = createDiagnosticsPanel();

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

        // Diagnostics panel
        document.getElementById('diagnostics-btn')?.addEventListener('click', () => {
            this.diagnosticsPanel?.open();
        });

        // Document workspace
        document.getElementById('document-workspace-btn')?.addEventListener('click', () => {
            this.documentWorkspace?.open();
        });

        // Saved research reports library
        document.getElementById('research-reports-btn')?.addEventListener('click', () => {
            this.researchReportsPanel?.open();
        });

        // Notes and tasks workspace
        document.getElementById('notes-tasks-btn')?.addEventListener('click', () => {
            this.notesTasksPanel?.open();
        });

        // Multi-model compare & committee mode
        document.getElementById('compare-btn')?.addEventListener('click', () => {
            this.comparePanel?.open();
        });

        // Contacts and people workspace
        document.getElementById('contacts-btn')?.addEventListener('click', () => {
            this.contactsPanel?.open();
        });

        // Image gallery and editor workspace
        document.getElementById('image-gallery-btn')?.addEventListener('click', () => {
            this.imageGalleryPanel?.open();
        });

        // Calendar workspace
        document.getElementById('calendar-btn')?.addEventListener('click', () => {
            this.calendarPanel?.open();
        });

        // Email workspace + AI triage
        document.getElementById('email-btn')?.addEventListener('click', () => {
            this.emailPanel?.open();
        });

        // Backup, restore, and self-hosted operations
        document.getElementById('backup-btn')?.addEventListener('click', () => {
            this.backupPanel?.open();
        });

        // Memory panel
        document.getElementById('memory-btn')?.addEventListener('click', () => {
            this.memoryPanel?.open();
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to stop generation or close mobile sidebar
            if (e.key === 'Escape') {
                if (this.documentWorkspace?.isOpen) {
                    this.documentWorkspace.close();
                    return;
                }
                if (this.researchReportsPanel?.isOpen()) {
                    this.researchReportsPanel.close();
                    return;
                }
                if (this.notesTasksPanel?.isOpen()) {
                    this.notesTasksPanel.close();
                    return;
                }
                if (this.comparePanel?.isOpen()) {
                    this.comparePanel.close();
                    return;
                }
                if (this.contactsPanel?.isOpen()) {
                    this.contactsPanel.close();
                    return;
                }
                if (this.imageGalleryPanel?.isOpen()) {
                    this.imageGalleryPanel.close();
                    return;
                }
                if (this.calendarPanel?.isOpen()) {
                    this.calendarPanel.close();
                    return;
                }
                if (this.emailPanel?.isOpen()) {
                    this.emailPanel.close();
                    return;
                }
                if (this.backupPanel?.isOpen()) {
                    this.backupPanel.close();
                    return;
                }
                if (this.memoryPanel?.isOpen) {
                    this.memoryPanel.close();
                    return;
                }
                if (this.diagnosticsPanel?.isOpen()) {
                    this.diagnosticsPanel.close();
                    return;
                }
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

/**
 * StorageService - Handles persistence using localStorage
 * Provides abstraction layer for future storage backend changes
 */

const STORAGE_PREFIX = 'synapse_';
const CHATS_KEY = `${STORAGE_PREFIX}chats`;
const SETTINGS_KEY = `${STORAGE_PREFIX}settings`;

class StorageService {
    /**
     * Save chats to storage
     * @param {Object} chats - Chat data object keyed by chat ID
     */
    saveChats(chats) {
        try {
            localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
        } catch (error) {
            console.error('Failed to save chats:', error);
            if (error.name === 'QuotaExceededError') {
                this.handleQuotaExceeded();
            }
        }
    }

    /**
     * Load chats from storage
     * @returns {Object} Chat data object
     */
    loadChats() {
        try {
            const data = localStorage.getItem(CHATS_KEY);
            return data ? JSON.parse(data) : {};
        } catch (error) {
            console.error('Failed to load chats:', error);
            return {};
        }
    }

    /**
     * Save application settings
     * @param {Object} settings - Settings object
     */
    saveSettings(settings) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (error) {
            console.error('Failed to save settings:', error);
        }
    }

    /**
     * Load application settings
     * @returns {Object} Settings object
     */
    loadSettings() {
        try {
            const data = localStorage.getItem(SETTINGS_KEY);
            return data ? JSON.parse(data) : this.getDefaultSettings();
        } catch (error) {
            console.error('Failed to load settings:', error);
            return this.getDefaultSettings();
        }
    }

    /**
     * Get default settings
     * @returns {Object}
     */
    getDefaultSettings() {
        return {
            selectedProvider: 'ollama',
            selectedModel: null,
            thinkingCollapsed: true,
            sidebarOpen: true,
            titleProvider: 'ollama',
            titleModel: 'gemma3:1b'
        };
    }

    /**
     * Export all chats as JSON string
     * @returns {string} JSON string of all chats
     */
    exportChats() {
        const chats = this.loadChats();
        return JSON.stringify(chats, null, 2);
    }

    /**
     * Import chats from JSON string
     * @param {string} jsonString - JSON string of chats
     * @param {boolean} merge - Whether to merge with existing chats
     * @returns {Object} Imported chats
     */
    importChats(jsonString, merge = true) {
        try {
            const importedChats = JSON.parse(jsonString);

            if (merge) {
                const existingChats = this.loadChats();
                const mergedChats = { ...existingChats, ...importedChats };
                this.saveChats(mergedChats);
                return mergedChats;
            } else {
                this.saveChats(importedChats);
                return importedChats;
            }
        } catch (error) {
            console.error('Failed to import chats:', error);
            throw new Error('Invalid JSON format');
        }
    }

    /**
     * Clear all stored data
     */
    clearAll() {
        localStorage.removeItem(CHATS_KEY);
        localStorage.removeItem(SETTINGS_KEY);
    }

    /**
     * Get storage usage info
     * @returns {{ used: number, available: number }}
     */
    getStorageInfo() {
        let used = 0;
        for (const key in localStorage) {
            if (key.startsWith(STORAGE_PREFIX)) {
                used += localStorage.getItem(key)?.length || 0;
            }
        }
        // Estimate: localStorage typically has 5MB limit
        const available = 5 * 1024 * 1024 - used;
        return { used, available };
    }

    /**
     * Handle storage quota exceeded
     * @private
     */
    handleQuotaExceeded() {
        console.warn('Storage quota exceeded. Consider exporting and clearing old chats.');
        // Dispatch a custom event so UI layers (e.g. toast) can react without a hard import dependency
        window.dispatchEvent(new CustomEvent('synapse:quotaExceeded'));
    }
}

// Export singleton instance
export const storageService = new StorageService();

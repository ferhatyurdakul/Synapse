/**
 * ProviderManager - Manages active LLM provider (Ollama, LM Studio)
 * Acts as a single entry point for provider-related operations
 */

import { ollamaService } from './ollamaService.js?v=27';
import { lmStudioService } from './lmStudioService.js?v=27';
import { storageService } from './storageService.js?v=27';
import { eventBus, Events } from '../utils/eventBus.js?v=27';

const PROVIDERS = {
    ollama: {
        name: 'ollama',
        label: 'Ollama',
        service: ollamaService,
        defaultUrl: 'http://localhost:11434'
    },
    lmstudio: {
        name: 'lmstudio',
        label: 'LM Studio',
        service: lmStudioService,
        defaultUrl: 'http://localhost:1234'
    }
};

class ProviderManager {
    constructor() {
        const settings = storageService.loadSettings();
        this.currentProvider = settings.selectedProvider || 'ollama';
    }

    /**
     * Get the active provider service instance
     * @returns {Object} Provider service (ollamaService or lmStudioService)
     */
    getProvider() {
        return PROVIDERS[this.currentProvider]?.service || ollamaService;
    }

    /**
     * Get the current provider name
     * @returns {string} 'ollama' or 'lmstudio'
     */
    getProviderName() {
        return this.currentProvider;
    }

    /**
     * Get the current provider label
     * @returns {string} 'Ollama' or 'LM Studio'
     */
    getProviderLabel() {
        return PROVIDERS[this.currentProvider]?.label || 'Ollama';
    }

    /**
     * Switch to a different provider
     * @param {string} providerName - 'ollama' or 'lmstudio'
     */
    setProvider(providerName) {
        if (!PROVIDERS[providerName]) {
            console.error(`Unknown provider: ${providerName}`);
            return;
        }

        // Abort any ongoing request from current provider
        this.getProvider().abort();

        this.currentProvider = providerName;

        // Persist
        const settings = storageService.loadSettings();
        settings.selectedProvider = providerName;
        storageService.saveSettings(settings);

        eventBus.emit(Events.PROVIDER_CHANGED, {
            provider: providerName,
            label: PROVIDERS[providerName].label
        });
    }

    /**
     * Get a specific provider service by name
     * @param {string} providerName - 'ollama' or 'lmstudio'
     * @returns {Object} Provider service
     */
    getProviderByName(providerName) {
        return PROVIDERS[providerName]?.service || null;
    }

    /**
     * Get all available providers
     * @returns {Array<{name: string, label: string}>}
     */
    getAllProviders() {
        return Object.values(PROVIDERS).map(p => ({
            name: p.name,
            label: p.label
        }));
    }
}

export const providerManager = new ProviderManager();

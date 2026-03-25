/**
 * ProviderManager - Manages active LLM provider (Ollama, LM Studio)
 * Acts as a single entry point for provider-related operations
 */

import { ollamaService } from './ollamaService.js?v=35';
import { lmStudioService } from './lmStudioService.js?v=35';
import { storageService } from './storageService.js?v=35';
import { eventBus, Events } from '../utils/eventBus.js?v=35';

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
        this.currentProvider = 'ollama';
        this._applySettings();
    }

    /**
     * Re-read settings and apply provider config.
     * Called after storageService.init() to pick up saved settings.
     */
    _applySettings() {
        const settings = storageService.loadSettings();
        this.currentProvider = settings.selectedProvider || 'ollama';

        if (settings.providerUrls) {
            for (const [name, url] of Object.entries(settings.providerUrls)) {
                if (PROVIDERS[name] && url) {
                    PROVIDERS[name].service.baseUrl = url;
                }
            }
        }
    }

    /**
     * Reload settings from storage. Call after storageService.init().
     */
    reload() {
        this._applySettings();
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

        // Abort any ongoing request from current provider and unblock the UI
        this.getProvider().abort();
        eventBus.emit(Events.STREAM_END, { aborted: true });

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
     * Get a provider's current base URL
     */
    getProviderUrl(providerName) {
        return PROVIDERS[providerName]?.service.baseUrl || PROVIDERS[providerName]?.defaultUrl || '';
    }

    /**
     * Get a provider's default base URL
     */
    getDefaultUrl(providerName) {
        return PROVIDERS[providerName]?.defaultUrl || '';
    }

    /**
     * Update a provider's base URL and persist it
     */
    setProviderUrl(providerName, url) {
        if (!PROVIDERS[providerName]) return;
        // Strip trailing slash
        const cleaned = url.replace(/\/+$/, '');
        PROVIDERS[providerName].service.baseUrl = cleaned;

        const settings = storageService.loadSettings();
        if (!settings.providerUrls) settings.providerUrls = {};
        settings.providerUrls[providerName] = cleaned;
        storageService.saveSettings(settings);
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

/**
 * SettingsPanel - Modal component for application settings
 */

import { titleService } from '../services/titleService.js?v=17';
import { ollamaService } from '../services/ollamaService.js?v=17';
import { eventBus, Events } from '../utils/eventBus.js?v=17';

class SettingsPanel {
    constructor() {
        this.isOpen = false;
        this.models = [];
        this.render();
        this.attachEventListeners();
    }

    render() {
        // Create modal container
        const modal = document.createElement('div');
        modal.id = 'settings-modal';
        modal.className = 'settings-modal hidden';
        modal.innerHTML = `
            <div class="settings-overlay"></div>
            <div class="settings-panel">
                <div class="settings-header">
                    <h2>⚙️ Settings</h2>
                    <button id="settings-close-btn" class="settings-close-btn">×</button>
                </div>
                <div class="settings-content">
                    <div class="settings-section">
                        <h3>Title Generation</h3>
                        <p class="settings-description">Choose which model generates chat titles automatically.</p>
                        <div class="settings-field">
                            <label for="title-model-select">Title Model</label>
                            <select id="title-model-select" class="settings-select">
                                <option value="">Loading models...</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="settings-footer">
                    <button id="settings-save-btn" class="settings-btn primary">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    attachEventListeners() {
        // Close button
        document.getElementById('settings-close-btn').addEventListener('click', () => {
            this.close();
        });

        // Overlay click
        document.querySelector('.settings-overlay').addEventListener('click', () => {
            this.close();
        });

        // Save button
        document.getElementById('settings-save-btn').addEventListener('click', () => {
            this.save();
        });

        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }

    async open() {
        this.isOpen = true;
        const modal = document.getElementById('settings-modal');
        modal.classList.remove('hidden');

        // Load models
        await this.loadModels();

        // Set current values
        this.loadCurrentSettings();
    }

    close() {
        this.isOpen = false;
        document.getElementById('settings-modal').classList.add('hidden');
    }

    async loadModels() {
        const select = document.getElementById('title-model-select');

        try {
            this.models = await ollamaService.listModels();

            select.innerHTML = this.models.map(model =>
                `<option value="${model.name}">${model.name}</option>`
            ).join('');

            // If no models, show placeholder
            if (this.models.length === 0) {
                select.innerHTML = '<option value="">No models available</option>';
            }
        } catch (error) {
            console.error('Failed to load models:', error);
            select.innerHTML = '<option value="">Failed to load models</option>';
        }
    }

    loadCurrentSettings() {
        const select = document.getElementById('title-model-select');
        const currentModel = titleService.getTitleModel();

        // Set selected value
        if (currentModel && select.querySelector(`option[value="${currentModel}"]`)) {
            select.value = currentModel;
        } else if (this.models.length > 0) {
            // Default to first available model
            select.value = this.models[0].name;
        }
    }

    save() {
        const select = document.getElementById('title-model-select');
        const selectedModel = select.value;

        if (selectedModel) {
            titleService.setTitleModel(selectedModel);
        }

        this.close();
        eventBus.emit(Events.SETTINGS_UPDATED, { titleModel: selectedModel });
    }
}

// Export singleton and factory
let settingsPanelInstance = null;

export function createSettingsPanel() {
    if (!settingsPanelInstance) {
        settingsPanelInstance = new SettingsPanel();
    }
    return settingsPanelInstance;
}

export function openSettings() {
    if (!settingsPanelInstance) {
        settingsPanelInstance = new SettingsPanel();
    }
    settingsPanelInstance.open();
}

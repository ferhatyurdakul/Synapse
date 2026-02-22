/**
 * ContextMeter - Displays context window usage as a progress bar
 * Shows used/max tokens with color-coded progress
 */

import { eventBus, Events } from '../utils/eventBus.js?v=22';
import { getModelParams } from './settingsPanel.js?v=22';

class ContextMeter {
    constructor() {
        this.used = 0;
        this.max = 4096;
        this.visible = this.getVisibilitySetting();
        this.render();
        this.attachEvents();
    }

    getVisibilitySetting() {
        const stored = localStorage.getItem('synapse_show_context_meter');
        return stored === null ? true : stored === 'true';
    }

    render() {
        const meter = document.createElement('div');
        meter.id = 'context-meter';
        meter.className = 'context-meter';
        if (!this.visible) meter.classList.add('hidden');
        meter.innerHTML = `
            <div class="context-meter-bar">
                <div class="context-meter-fill" id="context-meter-fill"></div>
            </div>
            <span class="context-meter-text" id="context-meter-text">0 / 0 tokens</span>
        `;

        // Insert above the input area
        const inputContainer = document.getElementById('input-area-container');
        if (inputContainer) {
            inputContainer.parentNode.insertBefore(meter, inputContainer);
        }
    }

    attachEvents() {
        eventBus.on(Events.CONTEXT_UPDATED, (data) => {
            this.update(data.used, data.max);
        });

        eventBus.on(Events.SETTINGS_UPDATED, (data) => {
            if (data.showContextMeter !== undefined) {
                this.visible = data.showContextMeter;
                const el = document.getElementById('context-meter');
                if (el) {
                    el.classList.toggle('hidden', !this.visible);
                }
            }
        });

        // Reset on chat switch
        eventBus.on(Events.CHAT_SELECTED, () => {
            this.update(0, 0);
        });

        // Reset on new chat
        eventBus.on(Events.CHAT_CREATED, () => {
            this.update(0, 0);
        });
    }

    update(used, max) {
        this.used = used;
        this.max = max;

        const fill = document.getElementById('context-meter-fill');
        const text = document.getElementById('context-meter-text');
        if (!fill || !text) return;

        const meter = document.getElementById('context-meter');

        // Hide if no data yet
        if (max === 0) {
            if (meter && this.visible) meter.classList.add('no-data');
            text.textContent = '—';
            fill.style.width = '0%';
            return;
        }

        if (meter) meter.classList.remove('no-data');

        const percent = Math.min((used / max) * 100, 100);
        fill.style.width = `${percent}%`;

        // Color shift: cyan → yellow → red
        if (percent < 50) {
            fill.className = 'context-meter-fill level-ok';
        } else if (percent < 80) {
            fill.className = 'context-meter-fill level-warn';
        } else {
            fill.className = 'context-meter-fill level-danger';
        }

        // Format numbers with commas
        const usedStr = used.toLocaleString();
        const maxStr = max.toLocaleString();
        text.textContent = `${usedStr} / ${maxStr} tokens`;
    }
}

let contextMeterInstance = null;

export function createContextMeter() {
    if (!contextMeterInstance) {
        contextMeterInstance = new ContextMeter();
    }
    return contextMeterInstance;
}

/**
 * ContextMeter - Displays context window usage as a progress bar
 * Shows used/max tokens with color-coded progress
 */

import { eventBus, Events } from '../utils/eventBus.js?v=23';

class ContextMeter {
    constructor() {
        this.used = 0;
        this.max = 0;
        this.render();
        this.attachEvents();
    }

    render() {
        const meter = document.createElement('div');
        meter.id = 'context-meter';
        meter.className = 'context-meter';
        meter.innerHTML = `
            <div class="context-meter-bar">
                <div class="context-meter-fill" id="context-meter-fill"></div>
            </div>
            <span class="context-meter-text" id="context-meter-text">—</span>
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

        // Show dash on chat switch / new chat (no data yet)
        eventBus.on(Events.CHAT_SELECTED, () => {
            this.reset();
        });

        eventBus.on(Events.CHAT_CREATED, () => {
            this.reset();
        });
    }

    reset() {
        this.used = 0;
        this.max = 0;
        const fill = document.getElementById('context-meter-fill');
        const text = document.getElementById('context-meter-text');
        if (fill) fill.style.width = '0%';
        if (text) text.textContent = '—';
    }

    update(used, max) {
        this.used = used;
        this.max = max;

        const fill = document.getElementById('context-meter-fill');
        const text = document.getElementById('context-meter-text');
        if (!fill || !text) return;

        if (max === 0) {
            fill.style.width = '0%';
            text.textContent = '—';
            return;
        }

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

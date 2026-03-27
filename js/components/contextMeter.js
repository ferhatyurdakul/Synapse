/**
 * ContextMeter - Displays context window usage as a progress bar
 * Shows used/max tokens with color-coded progress
 */

import { eventBus, Events } from '../utils/eventBus.js?v=36';

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
        meter.className = 'context-meter hidden';
        meter.innerHTML = `
            <div class="context-meter-bar">
                <div class="context-meter-fill" id="context-meter-fill"></div>
            </div>
            <span class="context-meter-text" id="context-meter-text">—</span>
            <span class="context-meter-summarized-wrapper hidden" id="context-meter-summarized-wrapper">
                <i data-lucide="scroll-text" class="icon context-meter-summarized-icon"></i>
                <div class="context-summary-tooltip" id="context-summary-tooltip"></div>
            </span>
        `;
        refreshIcons();

        // Insert above the input area
        const inputContainer = document.getElementById('input-area-container');
        if (inputContainer) {
            inputContainer.parentNode.insertBefore(meter, inputContainer);
        }
    }

    attachEvents() {
        eventBus.on(Events.CONTEXT_UPDATED, (data) => {
            this.update(data.used, data.max, data.summarized, data.summaryText);
        });

        // Reset only on new chat creation (empty chat)
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
        document.getElementById('context-meter')?.classList.add('hidden');
        document.getElementById('context-meter-summarized-wrapper')?.classList.add('hidden');
    }

    update(used, max, summarized = false, summaryText = null) {
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

        document.getElementById('context-meter')?.classList.remove('hidden');
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

        const wrapper = document.getElementById('context-meter-summarized-wrapper');
        const tooltip = document.getElementById('context-summary-tooltip');
        if (wrapper) wrapper.classList.toggle('hidden', !summarized);
        if (tooltip && summaryText) tooltip.textContent = summaryText;
    }
}

let contextMeterInstance = null;

export function createContextMeter() {
    if (!contextMeterInstance) {
        contextMeterInstance = new ContextMeter();
    }
    return contextMeterInstance;
}

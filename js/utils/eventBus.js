/**
 * EventBus - Simple pub/sub system for module communication
 * Enables loose coupling between components
 */
class EventBus {
    constructor() {
        this.events = {};
    }

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(callback);

        // Return unsubscribe function
        return () => {
            this.events[event] = this.events[event].filter(cb => cb !== callback);
        };
    }

    /**
     * Subscribe to an event once
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     */
    once(event, callback) {
        const unsubscribe = this.on(event, (...args) => {
            unsubscribe();
            callback(...args);
        });
    }

    /**
     * Emit an event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    emit(event, data) {
        if (this.events[event]) {
            this.events[event].forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in event handler for "${event}":`, error);
                }
            });
        }
    }

    /**
     * Remove all listeners for an event
     * @param {string} event - Event name
     */
    off(event) {
        delete this.events[event];
    }
}

// Export singleton instance
export const eventBus = new EventBus();

// Event constants for type safety
export const Events = {
    // Model events
    MODEL_CHANGED: 'model:changed',
    MODELS_LOADED: 'models:loaded',

    // Chat events
    CHAT_CREATED: 'chat:created',
    CHAT_SELECTED: 'chat:selected',
    CHAT_DELETED: 'chat:deleted',
    CHAT_UPDATED: 'chat:updated',
    TITLE_GENERATED: 'chat:titleGenerated',

    // Message events
    MESSAGE_SENT: 'message:sent',
    MESSAGE_RECEIVED: 'message:received',
    STREAM_CHUNK: 'stream:chunk',
    STREAM_START: 'stream:start',
    STREAM_END: 'stream:end',
    STREAM_ERROR: 'stream:error',

    // UI events
    SIDEBAR_TOGGLE: 'sidebar:toggle',
    THINKING_TOGGLE: 'thinking:toggle',

    // Storage events
    CHATS_IMPORTED: 'chats:imported',
    CHATS_EXPORTED: 'chats:exported',

    // Settings events
    SETTINGS_UPDATED: 'settings:updated',

    // Context events
    CONTEXT_UPDATED: 'context:updated'
};

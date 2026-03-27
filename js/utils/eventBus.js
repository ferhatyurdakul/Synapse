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

        // Skip duplicate registrations of the same function reference
        if (this.events[event].includes(callback)) {
            return () => this.off(event, callback);
        }

        this.events[event].push(callback);

        return () => this.off(event, callback);
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
     * Remove a specific listener, or all listeners for an event if no callback given
     * @param {string} event - Event name
     * @param {Function} [callback] - Handler to remove; omit to remove all for this event
     */
    off(event, callback) {
        if (!callback) {
            delete this.events[event];
        } else if (this.events[event]) {
            this.events[event] = this.events[event].filter(cb => cb !== callback);
        }
    }

    /**
     * Remove all listeners for all events
     */
    offAll() {
        this.events = {};
    }
}

// Export singleton instance
export const eventBus = new EventBus();

// Event constants for type safety
export const Events = {
    // Provider events
    PROVIDER_CHANGED: 'provider:changed',

    // Model events
    MODEL_CHANGED: 'model:changed',
    MODELS_LOADED: 'models:loaded',
    MODEL_LOADING: 'model:loading',
    MODEL_LOADED: 'model:loaded',

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
    CONTEXT_UPDATED: 'context:updated',

    // Vision events
    VISION_CAPABILITY_CHANGED: 'vision:capabilityChanged',

    // Active stream query (emitted on chat switch for inputArea to check)
    STREAM_STATUS_CHANGED: 'stream:statusChanged',

    // Tool events
    TOOL_RESULT: 'tool:result',
    WEB_SEARCH_TOGGLED: 'tool:webSearchToggled',
    TOOLS_CAPABILITY_CHANGED: 'tool:capabilityChanged',

    // RAG events
    RAG_COLLECTION_CREATED: 'rag:collectionCreated',
    RAG_COLLECTION_DELETED: 'rag:collectionDeleted',
    RAG_DOCUMENTS_ADDED: 'rag:documentsAdded',
    RAG_DOCUMENT_DELETED: 'rag:documentDeleted',
    RAG_EMBEDDING_PROGRESS: 'rag:embeddingProgress',
    RAG_EMBEDDING_COMPLETE: 'rag:embeddingComplete',
    RAG_EMBEDDING_ERROR: 'rag:embeddingError',
    RAG_SEARCH_EXECUTED: 'rag:searchExecuted'
};

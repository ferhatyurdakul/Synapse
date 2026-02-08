# Synapse Modules

This directory is reserved for future extensibility modules such as:

- **Web Search** - Integrate web search capabilities
- **RAG System** - Retrieval Augmented Generation with document context
- **Voice Input** - Speech-to-text integration
- **Image Generation** - DALL-E or Stable Diffusion integration
- **Custom Prompts** - System prompt management
- **Plugins** - Third-party plugin support

## Creating a New Module

Each module should follow this structure:

```
modules/
└── your-module/
    ├── index.js          # Main entry point
    ├── service.js        # API/data handling
    ├── component.js      # UI component (if needed)
    └── README.md         # Documentation
```

### Module Interface

Modules should export a standard interface:

```javascript
export default {
    name: 'module-name',
    version: '1.0.0',
    
    // Called when module is loaded
    init(eventBus, services) {
        // Register event handlers
        // Initialize services
    },
    
    // Called when module is unloaded
    destroy() {
        // Cleanup
    }
}
```

### Event Bus Integration

Use the global event bus for communication:

```javascript
import { eventBus, Events } from '../js/utils/eventBus.js';

// Subscribe to events
eventBus.on(Events.MESSAGE_SENT, ({ content }) => {
    // Process message before sending to AI
});

// Emit custom events
eventBus.emit('module:custom-event', data);
```

### Service Integration

Access existing services:

```javascript
import { ollamaService } from '../js/services/ollamaService.js';
import { chatService } from '../js/services/chatService.js';
import { storageService } from '../js/services/storageService.js';
```

## Example: Web Search Module

```javascript
// modules/web-search/index.js
import { eventBus, Events } from '../../js/utils/eventBus.js';

class WebSearchModule {
    name = 'web-search';
    version = '1.0.0';
    
    init() {
        // Add search button to UI
        this.addSearchButton();
        
        // Listen for search requests
        eventBus.on('search:request', this.handleSearch.bind(this));
    }
    
    async handleSearch({ query }) {
        // Perform search
        const results = await this.search(query);
        
        // Inject results into context
        eventBus.emit('context:inject', {
            source: 'web-search',
            content: results
        });
    }
    
    async search(query) {
        // Implement search logic
    }
    
    addSearchButton() {
        // Add UI elements
    }
    
    destroy() {
        // Cleanup
    }
}

export default new WebSearchModule();
```

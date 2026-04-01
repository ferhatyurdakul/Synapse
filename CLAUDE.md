# CLAUDE.md - Synapse

## Project Overview

Synapse is a browser-based chat client for local AI models (Ollama, LM Studio). Built with vanilla JavaScript (ES6 modules), CSS, and HTML — no build steps, bundlers, or npm dependencies. All data stays local via IndexedDB. MIT licensed.

## Quick Start

```bash
python3 server.py          # Starts dev server on port 8000
python3 server.py 3000     # Custom port
# Then open http://localhost:8000
```

Alternative (no Brave Search proxy): `python3 -m http.server 8000`

The dev server disables caching for `.js` and `.css` files automatically.

## Architecture

### Directory Structure

```
js/
  app.js                    # Main controller — initializes all components
  globals.js                # Global utility functions (CSP compliance)
  components/               # UI components (factory function pattern)
    chatSidebar.js           # Sidebar: folders, search, chat list, drag-and-drop
    chatView.js              # Chat display, streaming, markdown/LaTeX rendering
    contextMeter.js          # Context window usage indicator
    inputArea.js             # Message input, file/image attachments
    modelSelector.js         # Provider/model dropdown
    settingsPanel.js         # Tabbed settings modal (5 tabs)
    thinkingBlock.js         # Collapsible reasoning/thinking blocks
    toast.js                 # Toast notification system
  services/                 # Singleton service layer
    chatService.js           # Chat/message CRUD + persistence
    contextService.js        # Context tracking + auto-summarization
    embeddingsService.js     # Per-provider embedding generation
    idbStore.js              # Low-level IndexedDB wrapper
    lmStudioService.js       # LM Studio API client
    ollamaService.js         # Ollama API client
    providerManager.js       # Provider switching logic
    ragService.js            # Document ingestion, chunking, retrieval
    storageService.js        # IndexedDB persistence + localStorage migration
    themeService.js          # Theme switching + persistence
    titleService.js          # Auto-title generation via LLM
    toolRegistry.js          # Tool registration system
  tools/                    # Tool implementations
    builtins.js              # Built-in tools (date/time, calculator, etc.)
    webSearch.js             # Web search integration (Brave, SearXNG)
  utils/
    eventBus.js              # Pub/sub event system
    markdown.js              # Markdown + KaTeX LaTeX rendering
css/
  styles.css                # Base styles (Retro theme)
  themes/modern.css         # Modern theme overrides
index.html                  # Entry point with CSP policy + CDN links
server.py                   # Dev server + Brave API proxy
```

### Key Patterns

- **Factory functions for components**: Components are created via `createXxx(containerId)` functions that return configured DOM elements. They are NOT classes.
- **Singleton services**: Services export a single instance (e.g., `export const chatService = new ChatService()`).
- **EventBus pub/sub**: Components communicate through `eventBus.emit(Events.XXX, data)` and `eventBus.on(Events.XXX, callback)`. Event names are defined in `js/utils/eventBus.js`.
- **No framework**: Pure DOM manipulation. No React, Vue, or Svelte.
- **ES6 modules**: All files use `import`/`export`. Entry point is `<script type="module" src="js/app.js">`.

### Initialization Flow

1. `DOMContentLoaded` triggers `App.init()`
2. `storageService.init()` — opens IndexedDB, migrates from localStorage if needed
3. `providerManager.reload()` — loads saved provider settings
4. `themeService.applyTheme()` — applies saved theme
5. `chatService.load()` — loads chats/folders from IndexedDB
6. Provider connectivity check
7. Components created and mounted to DOM containers
8. Global event listeners registered

### Data Storage (IndexedDB)

Object stores: `settings`, `folders`, `chats`, `messages`, `attachments`, `modelSettings`, `uiState`

- Settings use a singleton record with key `"app"`
- Messages and attachments are lazy-loaded per chat
- StorageService uses write-behind caching for frequently accessed data

### CDN Dependencies

Libraries are loaded via CDN in `index.html` (no npm):
- **marked.js** — Markdown rendering
- **KaTeX 0.16.9** — LaTeX math rendering
- **DOMPurify 3** — HTML sanitization
- **PDF.js 4.9.155** — Client-side PDF extraction
- **Lucide Icons** — Icon system (call `refreshIcons()` after DOM changes)
- **JetBrains Mono** — Monospace font

### Content Security Policy

Strict CSP is defined in `index.html` `<meta>` tag. When adding new external resources, the CSP must be updated. Current allowed sources:
- Scripts: `self`, `unsafe-inline`, `cdn.jsdelivr.net`, `unpkg.com`
- Styles: `self`, `unsafe-inline`, `cdn.jsdelivr.net`, `fonts.googleapis.com`
- Fonts: `fonts.gstatic.com`
- Images: `self`, `data:`, `blob:`
- Connect: `*` (allows API calls to local AI servers)

## Development Guidelines

### No Build System

There is no bundler, transpiler, or package manager. Changes to `.js` and `.css` files are reflected immediately on browser refresh. Do not introduce build tooling unless explicitly requested.

### No Testing Framework

There are no automated tests. Do not add test files unless explicitly asked.

### Code Style

- Vanilla JavaScript ES6+ (no TypeScript)
- Components use factory function pattern, not classes
- Services use singleton class instances
- Use `eventBus` for cross-component communication, not direct imports between components
- HTML sanitization via DOMPurify is required for any user-generated content
- Use `refreshIcons()` after dynamically adding Lucide icon elements to the DOM

### Commit Convention

Use conventional commits:

```
<type>: <Short description>

- Change 1
- Change 2
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

Rules:
- Present tense ("Add" not "Added")
- Capitalize first letter
- No period at end of short description
- 50 char max for short description
- List changes as bullet points in body

### Security Considerations

- All user-generated HTML must pass through DOMPurify
- Code blocks use Base64 + URI encoding for safe clipboard operations
- CSP policy restricts script/style sources — update `index.html` meta tag if adding new CDN sources
- No `.env` files should be committed (already in `.gitignore`)
- `connect-src *` is intentional to allow connections to local AI servers on any port

## Provider APIs

- **Ollama**: REST API, default `http://localhost:11434`
- **LM Studio**: OpenAI-compatible API, default `http://localhost:1234`
- Both support streaming responses via Server-Sent Events
- Provider switching is managed by `providerManager.js`

## File Size Reference

The codebase is ~14,000 lines across ~35 files. Largest files:
- `chatSidebar.js` (~1,209 lines)
- `settingsPanel.js` (~1,061)
- `chatView.js` (~971)
- `chatService.js` (~706)
- `inputArea.js` (~621)
- `storageService.js` (~608)

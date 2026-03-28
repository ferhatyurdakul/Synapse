# Synapse

**One interface for all your local AI models.**

Synapse is a browser-based chat client that brings together every model running on your machine — whether through [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) — into a single, unified workspace. No cloud services, no accounts, no telemetry. Your conversations stay on your hardware.

Built with vanilla JavaScript, CSS, and HTML. No build step, no bundler, no npm.

## Why Synapse

Running local models often means juggling separate UIs for each provider, losing chat history between sessions, and missing features you'd expect from cloud-based alternatives. Synapse solves this:

- **All providers, one place** — Switch between Ollama and LM Studio models instantly. Configure custom endpoint URLs for remote or non-standard setups.
- **Persistent conversations** — All chats are stored locally in IndexedDB. Pick up where you left off, search across conversations, organize with folders.
- **Full-featured chat** — Streaming responses, image attachments for vision models, document upload with RAG, web search, tool calling, Markdown/LaTeX rendering, and more.

## Features

- **Multi-provider support** — Ollama and LM Studio with one-click switching and configurable URLs
- **Streaming responses** — Real-time token streaming with stop/cancel support
- **RAG document upload** — Attach PDFs and text files, embed them per-chat, and get context-aware answers with per-provider embedding model selection
- **Image support** — Attach and paste images for vision models, with lightbox zoom
- **Thinking/reasoning** — Collapsible thinking blocks for reasoning models (QwQ, DeepSeek-R1, etc.)
- **Tool calling** — Native function calling with web search (SearXNG or Brave Search)
- **System prompts** — Global default + per-folder overrides
- **Chat organization** — Folders, search, drag-and-drop, flagging, export (Markdown/HTML/PDF)
- **Model parameters** — Per-model temperature, top_p, top_k, context length, repeat penalty
- **Context management** — Visual context meter with automatic summarization when the window fills up
- **Auto titles** — LLM-generated chat titles after the first exchange
- **Markdown & LaTeX** — Full rendering with syntax highlighting and KaTeX math
- **Themes** — Switch between Retro (terminal aesthetic) and Modern (clean, minimal) in settings
- **Draft persistence** — Unsent messages are saved per-chat so you never lose work
- **Keyboard shortcuts** — Escape to stop generation, Enter to send, Shift+Enter for newlines

## Quick Start

**Prerequisites:** a running LLM provider — [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai).

```bash
# Clone the repo
git clone https://github.com/ferhat-yurdakul/synapse.git
cd synapse

# Start the server
python3 server.py
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

> `server.py` serves static files and includes a CORS proxy for Brave Search. If you don't need Brave Search, any static file server works: `python3 -m http.server 8000`

## Web Search

Synapse supports web search as a model tool. Toggle it with the globe button in the input area.

### SearXNG (recommended)

Run a local SearXNG instance — no API key needed:

```bash
docker run -p 8888:8080 searxng/searxng
```

Configure the URL in **Settings > Tools**.

### Brave Search

Requires an API key from [brave.com/search/api](https://brave.com/search/api) and `server.py` as the dev server (it proxies requests to avoid CORS).

Configure in **Settings > Tools > Brave Search**.

## Architecture

```
index.html                Entry point
server.py                 Dev server + Brave API proxy
css/
  styles.css              Base styles (Retro theme)
  themes/modern.css       Modern theme overrides
js/
  app.js                  Main application controller
  components/             UI components (factory function pattern)
    chatView.js           Chat display + streaming + retry
    chatSidebar.js        Sidebar with folders, search, chat list
    inputArea.js          Message input + file/image attach + web search
    settingsPanel.js      Tabbed settings modal with theme picker
    modelSelector.js      Provider/model dropdown
    contextMeter.js       Context window usage bar
    thinkingBlock.js      Collapsible thinking/reasoning display
  services/               Singleton service layer
    chatService.js        Chat/message CRUD + persistence
    ollamaService.js      Ollama API client
    lmStudioService.js    LM Studio API client
    providerManager.js    Provider switching
    storageService.js     IndexedDB persistence + migration
    contextService.js     Context tracking + summarization
    titleService.js       Auto title generation
    toolRegistry.js       Tool registration for function calling
    ragService.js         Document ingestion, chunking, and search
    embeddingsService.js  Per-provider embedding generation
    themeService.js       Theme switching + persistence
    idbStore.js           IndexedDB wrapper
  tools/                  Tool implementations
    builtins.js           Built-in tools
    webSearch.js          Web search (SearXNG + Brave)
  utils/
    eventBus.js           Pub/sub event system
    markdown.js           Markdown + LaTeX rendering
```

## Settings

The settings panel has five tabs:

| Tab | Contents |
|-----|----------|
| **General** | Theme picker, system prompt, provider URLs with connection test |
| **Models** | Per-model parameters (sliders), title generation model, summarization model |
| **Tools** | Web search provider configuration (SearXNG / Brave) |
| **RAG** | Per-provider embedding model selection (Ollama + LM Studio) |
| **Storage** | Storage usage stats, export/import, cleanup tools |

## License

[MIT](LICENSE)

# Synapse

A browser-based chat interface for local AI models. Connect to **Ollama** or **LM Studio**, chat with your models, and keep everything on your machine — no cloud, no accounts, no telemetry.

Built with vanilla JavaScript, CSS, and HTML. No build step, no bundler, no npm.

## Features

- **Multi-provider** — Switch between Ollama and LM Studio with one click
- **Streaming responses** — Real-time token streaming with background completion
- **Thinking/reasoning** — Collapsible thinking blocks for reasoning models (QwQ, DeepSeek-R1, etc.)
- **Tool calling** — Native function calling with web search (SearXNG or Brave Search)
- **Image support** — Attach and paste images for vision models, with lightbox zoom
- **System prompts** — Global default + per-folder overrides
- **Chat organization** — Folders, search, drag-and-drop, export (Markdown/HTML/PDF)
- **Model parameters** — Per-model temperature, top_p, top_k, context length, repeat penalty
- **Context management** — Automatic summarization when the context window fills up
- **Auto titles** — LLM-generated chat titles after the first exchange
- **Markdown & LaTeX** — Full rendering with syntax highlighting and KaTeX math

## Quick Start

Prerequisites: a running LLM provider — [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai).

```bash
# Clone the repo
git clone https://github.com/ferhat-yurdakul/synapse.git
cd synapse

# Start the dev server
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
index.html              Entry point
server.py               Dev server + Brave API proxy
js/
  app.js                Main application controller
  components/           UI components (factory function pattern)
    chatView.js         Chat display + streaming
    chatSidebar.js      Sidebar with folders, search, chat list
    inputArea.js        Message input + image attach + web search toggle
    settingsPanel.js    Tabbed settings modal
    modelSelector.js    Provider/model dropdown
    contextMeter.js     Context window usage bar
    thinkingBlock.js    Collapsible thinking/reasoning display
  services/             Singleton service layer
    chatService.js      Chat/message CRUD + persistence
    ollamaService.js    Ollama API client
    lmStudioService.js  LM Studio API client
    providerManager.js  Provider switching
    storageService.js   localStorage abstraction
    contextService.js   Context tracking + summarization
    titleService.js     Auto title generation
    toolRegistry.js     Tool registration for function calling
  tools/                Tool implementations
    builtins.js         Built-in tools
    webSearch.js        Web search (SearXNG + Brave)
  utils/
    eventBus.js         Pub/sub event system
    markdown.js         Markdown + LaTeX rendering
css/
  styles.css            All styles
```

## Settings

The settings panel has three tabs:

| Tab | Contents |
|-----|----------|
| **General** | System prompt, provider URLs with connection test |
| **Models** | Per-model parameters (sliders), title generation model, summarization model |
| **Tools** | Web search provider configuration (SearXNG / Brave) |

## License

[MIT](LICENSE)

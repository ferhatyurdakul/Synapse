# Synapse

**One interface for all your local AI models.**

Synapse is a browser-based chat client that brings together every model running on your machine — whether through [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) — into a single, unified workspace. No cloud services, no accounts, no telemetry. Your conversations stay on your hardware.

Built with vanilla JavaScript, CSS, and HTML. No build step, no bundler, no npm.

## Why Synapse

Running local models often means juggling separate UIs for each provider, losing chat history between sessions, and missing features you'd expect from cloud-based alternatives. Synapse solves this:

- **All providers, one place** — Switch between Ollama and LM Studio models instantly. Configure custom endpoint URLs for remote or non-standard setups.
- **Persistent conversations** — All chats are stored locally in IndexedDB. Pick up where you left off, search across conversations, organize with folders.
- **Workspace modes** — Split work into Chat, Research, Compare, Document, and Agent sessions with mode-aware history and empty states.
- **Full-featured chat** — Streaming responses, image attachments for vision models, document upload with RAG, web search, tool calling, Markdown/LaTeX rendering, and more.

## Features

- **Multi-provider support** — Ollama and LM Studio with one-click switching and configurable URLs
- **Streaming responses** — Real-time token streaming with stop/cancel support
- **RAG document upload** — Attach PDFs and text files, embed them per-chat, and get context-aware answers with per-provider embedding model selection
- **Image support** — Attach and paste images for vision models, with lightbox zoom
- **Thinking/reasoning** — Collapsible thinking blocks for reasoning models (QwQ, DeepSeek-R1, etc.)
- **Tool calling** — Native function calling with web search (SearXNG, Brave Search, or Tavily)
- **Workspace modes** — Dedicated Chat, Research, Compare, Document, and Agent session surfaces
- **System prompts** — Global default + per-folder overrides
- **Chat organization** — Folders, search, drag-and-drop, flagging, export (Markdown/HTML/PDF)
- **Model parameters** — Per-model temperature, top_p, top_k, context length, repeat penalty
- **Context management** — Visual context meter with automatic summarization when the window fills up
- **Personal memory** — Opt-in semantic memory: save facts, preferences, procedures, and context, and recall them into the system prompt. Saving is always explicit; nothing is ever captured automatically
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

> `server.py` serves static files and includes CORS proxies for Brave Search and Tavily. If you don't need either provider, any static file server works: `python3 -m http.server 8000`

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

### Tavily

Requires an API key from [tavily.com](https://tavily.com) and `server.py` as the dev server (it proxies requests to avoid CORS).

Configure in **Settings > Tools > Tavily**.

This release adds Tavily search only. Tavily content extraction is intentionally not wired into Synapse yet.

## Personal Memory

Synapse can keep a private, local semantic memory that the model reuses across chats. It is **off by default** and fully opt-in.

- **Enable recall:** Settings → Tools → **Personal Memory**. Until you turn this on, saved memories are never injected into the system prompt.
- **Saving is explicit only.** There is no automatic capture of your conversations. You add memories in two ways:
  - Click the **Save to memory** (bookmark) button on any chat message.
  - Add an entry by hand in the Memory panel (status bar → Memory → Add).
- **Privacy & control:** memories live only in your browser's IndexedDB and never leave your device. From the Memory panel you can search, edit, export (JSON), import, compact (merge near-duplicates), or **Clear All** to erase everything.

**V1 scope & limits:**

- Storage: IndexedDB (`memoryEntries` + `memoryEmbeddings` stores), reusing the same embedding model configured for RAG.
- Layers: `fact`, `preference`, `procedure`, `context`, scoped per project.
- Retrieval: hybrid vector (cosine) + keyword (BM25-style) similarity, weighted 70/30, with recency and confidence weighting. Policies (top-K, threshold, layers) differ per workspace mode.
- Limits: retrieval is bounded by mode-specific top-K and similarity thresholds; embeddings require a reachable embedding model. This is a V1 — there is no cross-device sync and no automatic summarization of memories into the store.

## Architecture

```
index.html                Entry point
server.py                 Dev server + Brave/Tavily API proxies
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
    webSearch.js          Web search (SearXNG + Brave + Tavily)
  utils/
    eventBus.js           Pub/sub event system
    markdown.js           Markdown + LaTeX rendering
```

## Integration API

`server.py` now includes a local integration layer for automation against selected Synapse backend capabilities. Management endpoints under `/api/integrations/*` are intended for the local operator and create runtime state in `.synapse/integrations.json`; generated secrets are shown only on create/rotate.

External callers use scoped API tokens:

```bash
# Create a token for the backend tool API
curl -s -X POST http://localhost:8000/api/integrations/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"automation","scopes":["tools:read","tools:run"],"expires_at":"2026-12-31T23:59:59+00:00"}'

# Call an externally exposed endpoint with the returned token in Authorization
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/api/tools/list
```

Supported token scopes are `tools:read`, `tools:run`, `mcp:discover`, `mcp:call`, `webhooks:receive`, and `webhooks:send`. Brave/Tavily proxy endpoints and `/api/integrations/*` management endpoints remain internal-only and are not bearer-token automation surfaces.

Webhook support includes:

- `POST /api/webhooks/inbound` — receives signed external events with an API-token Authorization header and `X-Synapse-Signature: sha256=<hmac>`.
- `POST /api/integrations/webhooks` — registers outbound webhook targets and returns a generated signing secret.
- `POST /api/webhooks/emit` — emits an event to matching outbound hooks, signing each JSON body with `X-Synapse-Signature`.
- `GET /api/integrations/audit` — tails local integration audit entries for token use and webhook delivery.

## Settings

The settings panel has five tabs:

| Tab | Contents |
|-----|----------|
| **General** | Theme picker, system prompt, provider URLs with connection test |
| **Models** | Per-model parameters (sliders), title generation model, summarization model |
| **Tools** | Web search provider configuration (SearXNG / Brave / Tavily) |
| **RAG** | Per-provider embedding model selection (Ollama + LM Studio) |
| **Storage** | Storage usage stats, export/import, cleanup tools |

## License

[MIT](LICENSE)

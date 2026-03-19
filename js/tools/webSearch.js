/**
 * Web Search tool — searches the web via SearXNG or Brave Search.
 * Registers into toolRegistry so models can call it via function calling.
 *
 * Providers:
 *  - SearXNG: runs locally, no CORS issues.
 *    Quick start: docker run -p 8888:8080 searxng/searxng
 *  - Brave: requires API key + local CORS proxy (server.py).
 *    Start with: python3 server.py [port]
 */

import { toolRegistry } from '../services/toolRegistry.js?v=34';
import { storageService } from '../services/storageService.js?v=34';

const MAX_RESULTS = 5;
const DEFAULT_SEARXNG_URL = 'http://localhost:8888';

/**
 * Search using SearXNG JSON API.
 */
async function searchSearXNG(query, baseUrl) {
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

    let response;
    try {
        response = await fetch(url);
    } catch {
        throw new Error(`Cannot reach SearXNG at ${baseUrl}. Is it running?`);
    }

    if (!response.ok) {
        throw new Error(`SearXNG returned ${response.status}. Check ${baseUrl}`);
    }

    const data = await response.json();
    return (data.results || []).slice(0, MAX_RESULTS).map(r => ({
        title: r.title,
        snippet: r.content || '',
        url: r.url
    }));
}

/**
 * Search using Brave Search API via local CORS proxy.
 */
async function searchBrave(query, apiKey) {
    const proxyUrl = `/api/brave/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;

    let response;
    try {
        response = await fetch(proxyUrl, {
            headers: {
                'X-Subscription-Token': apiKey,
                'Accept': 'application/json'
            }
        });
    } catch {
        throw new Error('Cannot reach Brave API proxy. Start the app with: python3 server.py');
    }

    if (!response.ok) {
        // If we get a 404, the proxy likely isn't running (regular static server)
        if (response.status === 404) {
            throw new Error('Brave proxy not found. Start the app with: python3 server.py');
        }
        // Try to get a short error message
        const contentType = response.headers.get('Content-Type') || '';
        let detail = '';
        if (contentType.includes('json')) {
            try {
                const err = await response.json();
                detail = err.error || JSON.stringify(err);
            } catch { detail = `HTTP ${response.status}`; }
        } else {
            detail = `HTTP ${response.status}`;
        }
        throw new Error(`Brave Search error: ${detail}`);
    }

    const data = await response.json();
    return (data.web?.results || []).slice(0, MAX_RESULTS).map(r => ({
        title: r.title,
        snippet: r.description || '',
        url: r.url
    }));
}

/**
 * Main handler — routes to configured search provider.
 */
async function handleWebSearch({ query }) {
    if (!query || !query.trim()) {
        throw new Error('No search query provided.');
    }

    const q = query.trim();
    const settings = storageService.loadSettings();
    const provider = settings.searchProvider || 'searxng';

    let results;
    if (provider === 'brave') {
        const apiKey = settings.braveApiKey;
        if (!apiKey) throw new Error('Brave API key not configured. Set it in Settings → Web Search.');
        results = await searchBrave(q, apiKey);
    } else {
        const baseUrl = settings.searxngUrl || DEFAULT_SEARXNG_URL;
        results = await searchSearXNG(q, baseUrl);
    }

    if (results.length === 0) {
        return `No results found for "${query}".`;
    }

    const lines = [`**Web search:** "${q}"\n`];
    results.forEach((r, i) => {
        lines.push(`${i + 1}. **${r.title}**`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push(`   ${r.url}\n`);
    });
    return lines.join('\n');
}

// ─── Register ─────────────────────────────────────────────────────────────────

toolRegistry.register({
    name: 'web_search',
    description: 'Search the web for current information. Use this when the user asks about recent events, facts you are unsure about, or anything that would benefit from up-to-date web results.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query to look up on the web'
            }
        },
        required: ['query']
    },
    handler: handleWebSearch
});

/**
 * BackendToolService — browser client for Synapse's local backend tool runner.
 *
 * The Python dev server exposes structured tool metadata and execution results at:
 *   GET  /api/tools/list
 *   POST /api/tools/run
 */

function normalizeBackendError(error, fallback = 'Backend tool request failed') {
    if (!error) return fallback;
    if (typeof error === 'string') return error;
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return fallback;
    }
}

class BackendToolService {
    constructor() {
        this.baseUrl = '';
    }

    async listTools({ signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/tools/list`, { signal });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(normalizeBackendError(payload?.error, `Tool list failed (${response.status})`));
        }
        return payload;
    }

    async runTool(tool, args = {}, { signal } = {}) {
        const response = await fetch(`${this.baseUrl}/api/tools/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool, args }),
            signal
        });

        const payload = await response.json().catch(() => ({
            ok: false,
            tool,
            error: `Malformed backend response (${response.status})`
        }));

        if (!response.ok || payload.ok === false) {
            return {
                ok: false,
                tool,
                ...payload,
                error: normalizeBackendError(payload.error, `Tool execution failed (${response.status})`)
            };
        }

        return payload;
    }

    formatResult(result) {
        if (!result) return 'Backend tool returned no result.';
        if (typeof result === 'string') return result;

        const lines = [];
        lines.push(`Backend tool: ${result.tool || 'unknown'}`);
        lines.push(`Status: ${result.ok ? 'ok' : 'failed'}`);
        if (result.policy) lines.push(`Policy: ${result.policy}`);
        if (result.elapsed_s !== undefined) lines.push(`Elapsed: ${result.elapsed_s}s`);
        if (result.error) lines.push(`Error: ${result.error}`);
        if (result.result !== undefined) {
            lines.push('Result:');
            lines.push(JSON.stringify(result.result, null, 2));
        }
        return lines.join('\n');
    }
}

export const backendToolService = new BackendToolService();

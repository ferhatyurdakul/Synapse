/**
 * Backend tools: controlled local file and shell actions proxied through server.py.
 *
 * These are intentionally routed through the Python backend so filesystem and
 * shell access stays policy-gated, workspace-scoped, audited, and structured.
 */

import { toolRegistry } from '../services/toolRegistry.js';
import { backendToolService } from '../services/backendToolService.js';

const BACKEND_TOOL_DEFINITIONS = [
    {
        name: 'backend_list_dir',
        backendName: 'list_dir',
        description: 'List files and folders inside the trusted Synapse workspace on the backend.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative workspace path to list. Defaults to the workspace root.' },
                show_hidden: { type: 'boolean', description: 'Include dotfiles and hidden directories. Defaults to false.' }
            },
            required: []
        }
    },
    {
        name: 'backend_read_file',
        backendName: 'read_file',
        description: 'Read a text file inside the trusted Synapse workspace on the backend.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative workspace file path to read.' },
                encoding: { type: 'string', description: 'Text encoding. Defaults to utf-8.' },
                max_bytes: { type: 'integer', description: 'Maximum bytes to return, capped by the backend.' }
            },
            required: ['path']
        }
    },
    {
        name: 'backend_write_file',
        backendName: 'write_file',
        description: 'Request a backend write inside the trusted Synapse workspace. Current backend policy requires approval.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative workspace file path to write.' },
                content: { type: 'string', description: 'Text content to write.' },
                append: { type: 'boolean', description: 'Append instead of overwrite. Defaults to false.' },
                create_dirs: { type: 'boolean', description: 'Create missing parent directories. Defaults to false.' }
            },
            required: ['path', 'content']
        }
    },
    {
        name: 'backend_shell',
        backendName: 'shell',
        description: 'Request a backend shell command in the trusted Synapse workspace. Current backend policy denies shell execution.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute.' },
                cwd: { type: 'string', description: 'Relative workspace directory for command execution.' },
                timeout: { type: 'integer', description: 'Timeout in seconds, capped by the backend.' }
            },
            required: ['command']
        }
    }
];

for (const definition of BACKEND_TOOL_DEFINITIONS) {
    toolRegistry.register({
        name: definition.name,
        description: definition.description,
        category: 'backend',
        parameters: definition.parameters,
        handler: async (args = {}) => {
            const result = await backendToolService.runTool(definition.backendName, args);
            return backendToolService.formatResult(result);
        }
    });
}

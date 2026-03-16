/**
 * ToolRegistry — registry for model-driven tools (function calling).
 *
 * Tool interface:
 *   name        {string}    tool name, e.g. 'calc'
 *   description {string}    one-line description for the model
 *   parameters  {Object}    JSON Schema for the function parameters (OpenAI format)
 *   handler     {(args: Object) => string | Promise<string>}
 *               Receives the parsed arguments object from the model.
 *               Return a markdown string to display as the result.
 *               Throw an Error with a user-friendly message on bad input.
 */
class ToolRegistry {
    constructor() {
        /** @type {Map<string, Object>} */
        this._tools = new Map();
    }

    /**
     * Register a tool. Overwrites any existing tool with the same name.
     * @param {Object} tool
     */
    register(tool) {
        if (!tool.name || typeof tool.handler !== 'function') {
            throw new Error('Tool must have a name and a handler function');
        }
        this._tools.set(tool.name, tool);
    }

    /** @param {string} name */
    get(name) {
        return this._tools.get(name);
    }

    /** Returns all registered tools sorted by name. */
    getAll() {
        return [...this._tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Returns tool schemas in OpenAI function-calling format.
     * Only tools with a `parameters` schema are included.
     * @returns {Array<{type: string, function: Object}>}
     */
    getSchemas() {
        return this.getAll()
            .filter(t => t.parameters)
            .map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }
            }));
    }

    /**
     * Execute a tool by name with a parsed arguments object.
     * @param {string} name
     * @param {Object} args
     * @returns {Promise<string>} markdown result
     */
    async execute(name, args) {
        const tool = this._tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        return tool.handler(args);
    }
}

export const toolRegistry = new ToolRegistry();

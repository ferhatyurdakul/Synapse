const SESSION_MODES = [
    {
        id: 'chat',
        label: 'Chat',
        shortLabel: 'Chat',
        icon: 'message-square',
        description: 'General-purpose conversations and quick back-and-forth work.',
        inputPlaceholder: 'Ask anything, brainstorm, or continue a conversation...',
        emptyStateTitle: 'Chat Workspace',
        emptyStateDescription: 'Open a model, kick off a conversation, and keep quick work moving.',
        starterPrompts: [
            { icon: '💬', text: 'Help me think through a tricky implementation tradeoff.' },
            { icon: '🧠', text: 'Summarize the key points from this idea and suggest next steps.' },
            { icon: '⚡', text: 'Give me a concise action plan for today based on this goal.' }
        ]
    },
    {
        id: 'research',
        label: 'Research',
        shortLabel: 'Research',
        icon: 'search',
        description: 'Structured exploration, notes, comparisons, and sourced investigation.',
        inputPlaceholder: 'Frame a research question, collect sources, or map what you need to learn...',
        emptyStateTitle: 'Research Workspace',
        emptyStateDescription: 'Use this mode for deeper investigation, evidence gathering, and synthesis.',
        starterPrompts: [
            { icon: '🔎', text: 'Investigate the tradeoffs between vector search and BM25 for local retrieval.' },
            { icon: '📚', text: 'Build a research brief on reinforcement learning from human feedback.' },
            { icon: '🗺️', text: 'Outline the open questions I should answer before starting this project.' }
        ]
    },
    {
        id: 'compare',
        label: 'Compare',
        shortLabel: 'Compare',
        icon: 'split-square-horizontal',
        description: 'Lay options side by side and pressure-test decisions before acting.',
        inputPlaceholder: 'Compare approaches, models, APIs, or decisions side by side...',
        emptyStateTitle: 'Compare Workspace',
        emptyStateDescription: 'Use this mode when you want clearer tradeoffs, alternatives, and recommendations.',
        starterPrompts: [
            { icon: '⚖️', text: 'Compare SQLite, Postgres, and LiteFS for a local-first product.' },
            { icon: '🧪', text: 'Evaluate these two UX directions and recommend one with reasoning.' },
            { icon: '📈', text: 'Compare three local models for coding, research, and summarization work.' }
        ]
    },
    {
        id: 'document',
        label: 'Document',
        shortLabel: 'Docs',
        icon: 'file-text',
        description: 'Document-grounded sessions for reading, extracting, and writing against files.',
        inputPlaceholder: 'Drop a document in, ask questions about it, or draft something grounded in source material...',
        emptyStateTitle: 'Document Workspace',
        emptyStateDescription: 'Bring files into the conversation and keep the session centered on source documents.',
        starterPrompts: [
            { icon: '📄', text: 'Extract the main claims from this paper and turn them into study notes.' },
            { icon: '✍️', text: 'Draft a cleaner version of this document while preserving its intent.' },
            { icon: '🧩', text: 'Find the sections I should quote or revisit before presenting this material.' }
        ]
    },
    {
        id: 'agent',
        label: 'Agent Runs',
        shortLabel: 'Agent',
        icon: 'bot',
        description: 'Longer-running execution sessions for delegated tasks, plans, and outcomes.',
        inputPlaceholder: 'Describe a task for the agent to execute, monitor, or continue...',
        emptyStateTitle: 'Agent Workspace',
        emptyStateDescription: 'Use this mode to frame concrete tasks, inspect progress, and resume execution threads.',
        starterPrompts: [
            { icon: '🤖', text: 'Plan a coding task, define milestones, and list the files likely to change.' },
            { icon: '🛠️', text: 'Take this bug report and turn it into an execution checklist with risks.' },
            { icon: '📋', text: 'Review the state of this feature and tell me what the next agent run should do.' }
        ]
    }
];

const SESSION_MODE_MAP = Object.fromEntries(SESSION_MODES.map(mode => [mode.id, mode]));

export function getSessionModes() {
    return SESSION_MODES.map(mode => ({ ...mode }));
}

export function normalizeSessionMode(mode) {
    if (!mode) return 'chat';
    const normalized = String(mode).trim().toLowerCase();
    return SESSION_MODE_MAP[normalized] ? normalized : 'chat';
}

export function getSessionModeConfig(mode) {
    return SESSION_MODE_MAP[normalizeSessionMode(mode)];
}

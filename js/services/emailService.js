/**
 * emailService — local-first email workspace data layer with AI triage.
 *
 * V1 is deliberately local-first: messages, accounts, drafts, triage state,
 * follow-up reminders and an append-only provenance log live in IndexedDB.
 * No IMAP/SMTP connection is performed in this build — account credentials are
 * stored as validation placeholders for a future explicit sync step.
 *
 * Mirrors the conventions of calendarService / notesTaskService.
 */
import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';
import { eventBus, Events } from '../utils/eventBus.js';

const ACCOUNT_PROVIDERS = ['local', 'gmail', 'outlook', 'yahoo', 'imap', 'pop3', 'ews', 'other'];
const PROTOCOLS = ['imap', 'pop3', 'ews', 'local'];
const CREDENTIAL_STATUSES = ['placeholder', 'unverified', 'verified'];
const FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'custom'];
const TRIAGE_CATEGORIES = ['inbox', 'reply', 'forward', 'read-later', 'archive', 'snooze', 'done'];
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const DRAFT_STATUSES = ['none', 'composing', 'pending-approval', 'approved', 'rejected', 'sent'];
const FOLLOWUP_STATUSES = ['pending', 'snoozed', 'done'];
const SOURCE_TYPES = ['manual', 'compose', 'forward', 'import', 'imap', 'agent', 'seed'];
const TRIAGE_ACTORS = ['user', 'heuristic', 'model', 'system'];

const SYSTEM_FOLDERS = [
    { role: 'inbox', name: 'Inbox', order: 0 },
    { role: 'sent', name: 'Sent', order: 1 },
    { role: 'drafts', name: 'Drafts', order: 2 },
    { role: 'archive', name: 'Archive', order: 3 },
    { role: 'spam', name: 'Spam', order: 4 },
    { role: 'trash', name: 'Trash', order: 5 }
];

const PRIORITY_SIGNALS = {
    urgent: ['urgent', 'asap', 'immediately', 'critical', 'emergency', 'action required', 'time-sensitive', 'right away'],
    high: ['important', 'priority', 'deadline', 'today', 'by end of day', 'eod', 'tomorrow', 'please review', 'blocker', 'escalat']
};

const CATEGORY_HINTS = {
    reply: ['can you', 'could you', 'would you', 'please', 'need you', 'let me know', 'reply', 'respond', 'confirm', 'approve', 'when can', 'are you available', 'questions?', 'your thoughts'],
    forward: ['fyi', 'forwarding', 'as discussed', 'looping in', 'introducing', 'please see below', 'sharing this', 'as requested'],
    archive: ['unsubscribe', 'newsletter', 'no-reply', 'digest', 'notification', 'automated', 'receipt', 'your order', 'invoice attached', 'policy update']
};

const DEFAULT_ACCOUNT = {
    id: 'acct_local',
    name: 'Local Mailbox',
    address: 'you@synapse.local',
    color: '#0ea5e9',
    enabled: true,
    provider: 'local'
};

function now() {
    return new Date().toISOString();
}

function uid(prefix = 'email') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function cleanText(value) {
    return String(value == null ? '' : value).trim();
}

function parseList(value) {
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
    return String(value || '').split(/[\n,;]/).map(cleanText).filter(Boolean);
}

function uniqueArr(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const key = cleanText(value).toLowerCase();
        if (key && !seen.has(key)) {
            seen.add(key);
            out.push(cleanText(value));
        }
    }
    return out;
}

function clamp01(value) {
    if (Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function toIso(value, fallback = null) {
    if (!value) return fallback;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function countHits(haystack, needles) {
    return needles.reduce((total, needle) => total + (haystack.includes(needle) ? 1 : 0), 0);
}

function normalizeAddress(value) {
    if (!value) return { name: '', address: '' };
    if (typeof value === 'string') {
        const match = value.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
        if (match) return { name: cleanText(match[1]), address: cleanText(match[2]).toLowerCase() };
        const bare = cleanText(value).toLowerCase();
        if (bare.includes('@')) return { name: bare.split('@')[0], address: bare };
        return { name: cleanText(value), address: bare };
    }
    return {
        name: cleanText(value.name || value.label),
        address: cleanText(value.address || value.email).toLowerCase()
    };
}

function normalizeAddresses(value) {
    const list = Array.isArray(value) ? value : [value].filter(Boolean);
    return list.map(normalizeAddress).filter(addr => addr.address || addr.name);
}

function normalizeAttachments(value = []) {
    const list = Array.isArray(value) ? value : [value].filter(Boolean);
    return list.map(item => typeof item === 'string' ? { name: item } : item)
        .map(item => ({
            id: item.id || uid('att'),
            name: cleanText(item.name || item.filename || 'attachment'),
            size: Number(item.size) || 0,
            contentType: cleanText(item.contentType || item.type || 'application/octet-stream'),
            inline: Boolean(item.inline)
        }))
        .filter(item => item.name);
}

function defaultTriage() {
    return { category: 'inbox', priority: 'none', summary: '', actionItems: [], suggestedReply: '', confidence: 0, triagedAt: null, triagedBy: null, snoozeUntil: null };
}

function normalizeTriage(input = {}) {
    if (!input) return defaultTriage();
    const category = TRIAGE_CATEGORIES.includes(input.category) ? input.category : 'inbox';
    const priority = PRIORITIES.includes(input.priority) ? input.priority : 'none';
    return {
        category,
        priority,
        summary: cleanText(input.summary),
        actionItems: Array.isArray(input.actionItems) ? input.actionItems.map(cleanText).filter(Boolean).slice(0, 12) : [],
        suggestedReply: cleanText(input.suggestedReply),
        confidence: clamp01(Number(input.confidence) || 0),
        triagedAt: input.triagedAt || null,
        triagedBy: TRIAGE_ACTORS.includes(input.triagedBy) ? input.triagedBy : null,
        snoozeUntil: input.snoozeUntil || null
    };
}

function normalizeDraft(input = {}, ctx = {}) {
    if (!input || input === false) return { isDraft: ctx.folder === 'drafts', status: 'none', subject: '', to: [], cc: [], bcc: [], body: '', inReplyTo: null, createdAt: null, approvedAt: null, rejectedAt: null, rejectionReason: '', sentAt: null };
    const status = DRAFT_STATUSES.includes(input.status) ? input.status : 'none';
    return {
        isDraft: input.isDraft != null ? Boolean(input.isDraft) : (ctx.folder === 'drafts' || status !== 'none'),
        status,
        subject: input.subject != null ? cleanText(input.subject) : cleanText(ctx.subject || ''),
        to: normalizeAddresses(input.to != null ? input.to : ctx.to || []),
        cc: normalizeAddresses(input.cc),
        bcc: normalizeAddresses(input.bcc),
        body: input.body != null ? String(input.body) : String(ctx.body || ''),
        inReplyTo: input.inReplyTo || null,
        createdAt: input.createdAt || now(),
        approvedAt: input.approvedAt || null,
        rejectedAt: input.rejectedAt || null,
        rejectionReason: cleanText(input.rejectionReason),
        sentAt: input.sentAt || null
    };
}

function normalizeFollowUp(input = {}) {
    if (!input) return { enabled: false, status: 'pending', dueAt: null, lastReminderAt: null };
    const status = FOLLOWUP_STATUSES.includes(input.status) ? input.status : 'pending';
    return {
        enabled: input.enabled != null ? Boolean(input.enabled) : Boolean(input.dueAt),
        status,
        dueAt: input.dueAt || null,
        lastReminderAt: input.lastReminderAt || null
    };
}

function normalizeProvenance(value = []) {
    const entries = Array.isArray(value) ? value : [value].filter(Boolean);
    return entries.map(entry => {
        if (typeof entry === 'string') return { at: now(), action: entry, actor: 'system', detail: '' };
        return {
            at: entry.at || now(),
            action: cleanText(entry.action) || 'event',
            actor: TRIAGE_ACTORS.includes(entry.actor) ? entry.actor : 'system',
            detail: cleanText(entry.detail)
        };
    });
}

function normalizeCredentials(input = {}) {
    return {
        status: CREDENTIAL_STATUSES.includes(input?.status) ? input.status : 'placeholder',
        username: cleanText(input?.username),
        host: cleanText(input?.host),
        port: Number(input?.port) || null,
        lastVerifiedAt: input?.lastVerifiedAt || null,
        note: cleanText(input?.note) || 'Placeholder: credentials not yet validated in this local-first build.'
    };
}

function normalizeAccount(input = {}) {
    const timestamp = now();
    const provider = ACCOUNT_PROVIDERS.includes(input.provider) ? input.provider : 'local';
    return {
        id: input.id || uid('acct'),
        name: cleanText(input.name) || 'Local Mailbox',
        address: cleanText(input.address).toLowerCase(),
        color: input.color || '#0ea5e9',
        enabled: input.enabled !== false,
        provider,
        protocol: PROTOCOLS.includes(input.protocol) ? input.protocol : (provider === 'pop3' ? 'pop3' : 'imap'),
        credentials: normalizeCredentials(input.credentials),
        imap: {
            host: cleanText(input.imap?.host),
            port: Number(input.imap?.port) || 993,
            tls: input.imap?.tls !== false
        },
        smtp: {
            host: cleanText(input.smtp?.host),
            port: Number(input.smtp?.port) || 465,
            tls: input.smtp?.tls !== false
        },
        sync: {
            enabled: Boolean(input.sync?.enabled),
            lastSyncAt: input.sync?.lastSyncAt || null,
            mode: input.sync?.mode || 'manual'
        },
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function normalizeFolder(input = {}, accountId = 'acct_local') {
    const timestamp = now();
    const role = FOLDER_ROLES.includes(input.role) ? input.role : 'custom';
    return {
        id: input.id || uid('folder'),
        accountId: input.accountId || accountId,
        name: cleanText(input.name) || (role[0].toUpperCase() + role.slice(1)),
        role,
        order: input.order != null ? Number(input.order) : 99,
        unread: Number(input.unread) || 0,
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function normalizeSubjectForThread(subject = '') {
    return cleanText(String(subject || '')).replace(/^\s*((re|fw|fwd|aw|sv|tr|odp)\s*:\s*)+/gi, '').toLowerCase() || '(no-subject)';
}

function normalizeMessage(input = {}) {
    const timestamp = now();
    const folder = (input.folder && FOLDER_ROLES.includes(input.folder)) ? input.folder : (input.folder || 'inbox');
    const from = normalizeAddress(input.from || input.sender);
    const subject = cleanText(input.subject) || '(no subject)';
    const threadId = input.threadId || normalizeSubjectForThread(subject);
    const date = toIso(input.date || input.receivedAt, timestamp);
    const body = String(input.body || input.text || '');
    const preview = cleanText(input.preview) || body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const sourceType = SOURCE_TYPES.includes(input.sourceType) ? input.sourceType : (SOURCE_TYPES.includes(input.source?.type) ? input.source.type : 'manual');
    return {
        id: input.id || uid('msg'),
        accountId: input.accountId || 'acct_local',
        messageId: input.messageId || `${uid('mid')}@synapse.local`,
        threadId,
        folder,
        from,
        to: normalizeAddresses(input.to || input.recipients),
        cc: normalizeAddresses(input.cc),
        bcc: normalizeAddresses(input.bcc),
        subject,
        preview,
        body,
        html: input.html || '',
        date,
        read: Boolean(input.read),
        starred: Boolean(input.starred),
        important: Boolean(input.important),
        attachments: normalizeAttachments(input.attachments),
        labels: parseList(input.labels),
        triage: normalizeTriage(input.triage),
        draft: normalizeDraft(input.draft, { folder, subject, body, to: input.to }),
        followUp: normalizeFollowUp(input.followUp),
        source: { type: sourceType, origin: input.source?.origin || '', capturedAt: input.source?.capturedAt || timestamp },
        provenance: normalizeProvenance(input.provenance),
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp
    };
}

function messageSearchText(message) {
    return [
        message.subject,
        message.preview,
        message.body,
        message.folder,
        message.from?.name,
        message.from?.address,
        ...(message.to || []).map(addr => `${addr.name} ${addr.address}`),
        ...(message.labels || []),
        message.triage?.category,
        message.triage?.priority
    ].join(' ').toLowerCase();
}

// ── Heuristic triage (deterministic, local-first AI assist) ────────────────

function detectPriority(text) {
    const lower = text.toLowerCase();
    if (PRIORITY_SIGNALS.urgent.some(signal => lower.includes(signal))) return 'urgent';
    if (PRIORITY_SIGNALS.high.some(signal => lower.includes(signal))) return 'high';
    return 'none';
}

function detectCategory(subject, text, fromAddress) {
    const haystack = `${subject}\n${text}`.toLowerCase();
    const sender = (fromAddress || '').toLowerCase();
    const replyHits = countHits(haystack, CATEGORY_HINTS.reply);
    const forwardHits = countHits(haystack, CATEGORY_HINTS.forward);
    const archiveHits = countHits(haystack, CATEGORY_HINTS.archive) + (/(no-?reply|mailer-?daemon|newsletter|digest|notifications?@)/.test(sender) ? 2 : 0);
    const max = Math.max(replyHits, forwardHits, archiveHits);
    if (max === 0) return { category: 'inbox', signals: 0 };
    if (archiveHits === max && archiveHits >= 2) return { category: replyHits ? 'read-later' : 'archive', signals: archiveHits };
    if (replyHits === max) return { category: 'reply', signals: replyHits };
    return { category: 'forward', signals: forwardHits };
}

function extractActionItems(text, max = 6) {
    const items = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = cleanText(raw);
        if (!line) continue;
        const stripped = line.replace(/^([-*]\s*\[\s*\]\s*|action\s*:\s*|to-?do\s*:\s*|please\s+)/i, '').replace(/^[-*]\s*/, '');
        if (stripped && stripped !== line && stripped.length > 2) items.push(stripped);
    }
    const dated = String(text || '').match(/[^.\n]*(\bby\b|\bdue\b|\bdeadline\b|\btoday\b|\btomorrow\b|at \d{1,2}|on (mon|tue|wed|thu|fri|sat|sun))[^\n.]*/gi) || [];
    return uniqueArr([...items, ...dated.map(cleanText)]).slice(0, max);
}

function suggestedReplyFor(category, fromName, priority) {
    const name = fromName ? ` ${fromName.split(/\s+/)[0]}` : '';
    if (category === 'reply') return `Hi${name}, thanks for your message. I've read it and will follow up${priority === 'urgent' ? ' today' : ' shortly'} with a proper response.`;
    if (category === 'forward') return `Forwarding for visibility${name ? '' : ''} — let me know how you'd like to proceed.`;
    if (category === 'read-later' || category === 'archive') return '(No reply needed — captured for reference.)';
    if (category === 'done') return 'Done — thanks for the note.';
    return `Hi${name}, acknowledged. I'll take a look and respond soon.`;
}

function summarize(text) {
    const flat = cleanText(String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    if (!flat) return '';
    const firstSentence = flat.split(/(?<=[.!?])\s+/)[0] || flat;
    return firstSentence.slice(0, 180);
}

// ── Minimal .eml parsing for import ────────────────────────────────────────

function parseEml(text = '') {
    const sep = text.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
    const splitIdx = text.indexOf(sep);
    let head = text;
    let body = text;
    if (splitIdx >= 0) {
        head = text.slice(0, splitIdx);
        body = text.slice(splitIdx + sep.length);
    }
    const headers = {};
    for (const line of head.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            const key = cleanText(line.slice(0, idx)).toLowerCase();
            const value = cleanText(line.slice(idx + 1));
            headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
        }
    }
    return { headers, body: cleanText(body) };
}

class EmailService {
    constructor() {
        this._followUpTimer = null;
        this._firedFollowUps = new Set();
    }

    async init() {
        await this.ensureDefaultAccount();
        await this.ensureSystemFolders();
        await this.ensureDemoData();
        this.startFollowUpLoop();
    }

    // ── Accounts ───────────────────────────────────────────────────────────

    async ensureDefaultAccount() {
        const existing = await getAllRecords('emailAccounts');
        if (existing.length) return existing;
        const account = normalizeAccount(DEFAULT_ACCOUNT);
        await putRecord('emailAccounts', account);
        return [account];
    }

    async listAccounts({ includeDisabled = true } = {}) {
        await this.ensureDefaultAccount();
        const accounts = await getAllRecords('emailAccounts');
        return accounts.filter(account => includeDisabled || account.enabled).sort((a, b) => a.name.localeCompare(b.name));
    }

    async getAccount(accountId) {
        return getRecord('emailAccounts', accountId);
    }

    async saveAccount(input) {
        const existing = input.id ? await this.getAccount(input.id) : null;
        const account = normalizeAccount({ ...existing, ...input, id: input.id || existing?.id, createdAt: existing?.createdAt });
        await putRecord('emailAccounts', account);
        eventBus.emit(Events.EMAIL_ACCOUNT_SAVED, account);
        return account;
    }

    async deleteAccount(accountId) {
        if (accountId === DEFAULT_ACCOUNT.id) {
            return this.saveAccount({ id: accountId, enabled: false });
        }
        await deleteRecord('emailAccounts', accountId);
        eventBus.emit(Events.EMAIL_ACCOUNT_SAVED, { id: accountId, deleted: true });
    }

    /**
     * Credential validation PLACEHOLDER. V1 is local-first and performs no
     * network connection. We persist the supplied fields and mark them
     * "unverified" so a future provider bridge can pick them up explicitly.
     */
    async validateCredentials(accountId, input = {}) {
        const account = await this.getAccount(accountId);
        if (!account) throw new Error(`Account not found: ${accountId}`);
        const note = 'V1 placeholder: credential fields saved locally. No IMAP/SMTP connection is performed in this build — wire up a provider bridge to enable real verification.';
        const credentials = normalizeCredentials({
            ...(input || {}),
            status: 'unverified',
            lastVerifiedAt: now(),
            username: input.username ?? account.credentials.username,
            host: input.host ?? (input.imap?.host || account.imap.host),
            port: input.port ?? (input.imap?.port || account.imap.port),
            note
        });
        const updated = await this.saveAccount({
            id: accountId,
            credentials,
            imap: { ...account.imap, ...(input.imap || {}) },
            smtp: { ...account.smtp, ...(input.smtp || {}) }
        });
        return { ok: false, verified: false, status: 'unverified', account: updated, message: note };
    }

    // ── Folders ────────────────────────────────────────────────────────────

    async ensureSystemFolders() {
        const existing = await getAllRecords('emailFolders');
        const have = new Set(existing.map(folder => `${folder.accountId}:${folder.role}`));
        const toCreate = [];
        for (const def of SYSTEM_FOLDERS) {
            const key = `${DEFAULT_ACCOUNT.id}:${def.role}`;
            if (!have.has(key)) toCreate.push(normalizeFolder({ id: `folder_${def.role}`, accountId: DEFAULT_ACCOUNT.id, name: def.name, role: def.role, order: def.order }));
        }
        for (const folder of toCreate) await putRecord('emailFolders', folder);
        return toCreate;
    }

    async listFolders(accountId) {
        await this.ensureSystemFolders();
        const folders = await getAllRecords('emailFolders');
        return folders
            .filter(folder => !accountId || folder.accountId === accountId)
            .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    }

    async saveFolder(input) {
        const folder = normalizeFolder(input, input.accountId || DEFAULT_ACCOUNT.id);
        await putRecord('emailFolders', folder);
        eventBus.emit(Events.EMAIL_UPDATED, { scope: 'folders' });
        return folder;
    }

    // ── Messages ───────────────────────────────────────────────────────────

    async getMessage(messageId) {
        return getRecord('emailMessages', messageId);
    }

    async listMessages(filters = {}) {
        await this.ensureDefaultAccount();
        const query = cleanText(filters.query).toLowerCase();
        let messages = await getAllRecords('emailMessages');
        if (filters.accountId) messages = messages.filter(message => message.accountId === filters.accountId);
        if (filters.folder) messages = messages.filter(message => message.folder === filters.folder);
        if (filters.threadId) messages = messages.filter(message => message.threadId === filters.threadId);
        if (filters.category) messages = messages.filter(message => message.triage?.category === filters.category);
        if (filters.priority) messages = messages.filter(message => message.triage?.priority === filters.priority);
        if (filters.unread) messages = messages.filter(message => !message.read);
        if (filters.starred) messages = messages.filter(message => message.starred);
        if (filters.drafts) messages = messages.filter(message => message.draft?.isDraft);
        if (filters.needsReply) messages = messages.filter(message => ['reply', 'forward'].includes(message.triage?.category));
        if (filters.followUpPending) messages = messages.filter(message => message.followUp?.enabled && message.followUp.status !== 'done');
        if (filters.since) messages = messages.filter(message => new Date(message.date) >= new Date(filters.since));
        if (query) messages = messages.filter(message => messageSearchText(message).includes(query));
        messages.sort((a, b) => new Date(b.date) - new Date(a.date));
        return messages;
    }

    async listThreads(filters = {}) {
        const messages = await this.listMessages(filters);
        const groups = new Map();
        for (const message of messages) {
            if (!groups.has(message.threadId)) groups.set(message.threadId, []);
            groups.get(message.threadId).push(message);
        }
        const threads = [];
        for (const [, items] of groups) {
            items.sort((a, b) => new Date(a.date) - new Date(b.date));
            const latest = items[items.length - 1];
            threads.push({
                threadId: latest.threadId,
                subject: latest.subject,
                count: items.length,
                unread: items.filter(item => !item.read).length,
                starred: items.some(item => item.starred),
                latest,
                participants: uniqueArr(items.flatMap(item => [item.from?.address, ...(item.to || []).map(addr => addr.address)])),
                messages: items
            });
        }
        threads.sort((a, b) => new Date(b.latest.date) - new Date(a.latest.date));
        return threads;
    }

    async saveMessage(input = {}) {
        const existing = input.id ? await this.getMessage(input.id) : null;
        const message = normalizeMessage({ ...existing, ...input, id: input.id || existing?.id, createdAt: existing?.createdAt });
        await putRecord('emailMessages', message);
        eventBus.emit(Events.EMAIL_MESSAGE_SAVED, message);
        return message;
    }

    async _patchMessage(messageId, patch, provenance = null) {
        const existing = await this.getMessage(messageId);
        if (!existing) throw new Error(`Message not found: ${messageId}`);
        const next = { ...existing, ...patch };
        if (provenance) {
            next.provenance = [...(existing.provenance || []), { at: now(), action: provenance.action, actor: provenance.actor || 'user', detail: cleanText(provenance.detail) }].slice(-100);
        }
        return this.saveMessage(next);
    }

    async markRead(messageId, read = true) {
        return this._patchMessage(messageId, { read }, { action: read ? 'marked-read' : 'marked-unread', actor: 'user' });
    }

    async toggleStar(messageId) {
        const message = await this.getMessage(messageId);
        return this._patchMessage(messageId, { starred: !message?.starred }, { action: 'toggled-star', actor: 'user' });
    }

    async moveToFolder(messageId, folder) {
        return this._patchMessage(messageId, { folder }, { action: `moved-to:${folder}`, actor: 'user' });
    }

    async archive(messageId) {
        return this.moveToFolder(messageId, 'archive');
    }

    async trash(messageId) {
        return this.moveToFolder(messageId, 'trash');
    }

    async deleteMessage(messageId) {
        await deleteRecord('emailMessages', messageId);
        eventBus.emit(Events.EMAIL_MESSAGE_DELETED, { id: messageId });
    }

    // ── AI triage ──────────────────────────────────────────────────────────

    /**
     * Heuristic AI triage. Classifies a message into a category + priority,
     * extracts action items, writes a short summary and a suggested reply.
     * Deterministic and offline — no model call in V1.
     */
    runHeuristic(message) {
        const subject = message.subject || '';
        const text = `${message.preview}\n${message.body || ''}`;
        const detection = detectCategory(subject, text, message.from?.address);
        const priority = detectPriority(text);
        const actionItems = extractActionItems(message.body);
        const resolvedPriority = priority !== 'none' ? priority : (detection.category === 'reply' ? 'medium' : (detection.category === 'archive' ? 'low' : 'none'));
        const confidence = clamp01(0.35 + detection.signals * 0.16 + (priority !== 'none' ? 0.18 : 0));
        return normalizeTriage({
            category: detection.category,
            priority: resolvedPriority,
            summary: summarize(text),
            actionItems,
            suggestedReply: suggestedReplyFor(detection.category, message.from?.name, resolvedPriority),
            confidence,
            triagedAt: now(),
            triagedBy: 'heuristic',
            snoozeUntil: null
        });
    }

    async triageMessage(messageId, { strategy = 'heuristic' } = {}) {
        const message = await this.getMessage(messageId);
        if (!message) throw new Error(`Message not found: ${messageId}`);
        const triage = strategy === 'model' ? { ...this.runHeuristic(message), triagedBy: 'model' } : this.runHeuristic(message);
        const updated = await this._patchMessage(messageId, {
            triage,
            important: triage.priority === 'urgent' || triage.priority === 'high'
        }, { action: 'triaged', detail: `${triage.category} · ${triage.priority} · conf ${triage.confidence.toFixed(2)}`, actor: triage.triagedBy });
        eventBus.emit(Events.EMAIL_TRIAGED, updated);
        return updated;
    }

    async triageBatch(messageIds = []) {
        const results = [];
        for (const messageId of messageIds) {
            try { results.push(await this.triageMessage(messageId)); } catch (err) { console.warn('[EmailService] triage failed for', messageId, err); }
        }
        return results;
    }

    async setTriageCategory(messageId, category) {
        const valid = TRIAGE_CATEGORIES.includes(category) ? category : 'inbox';
        return this._patchMessage(messageId, { triage: { ...(await this.getMessage(messageId))?.triage, category, triagedAt: now(), triagedBy: 'manual' } }, { action: `triage:${valid}`, actor: 'user' });
    }

    // ── Drafts and the approval gate ───────────────────────────────────────

    async composeDraft(input = {}) {
        const inReplyTo = input.inReplyTo ? await this.getMessage(input.inReplyTo) : null;
        const subject = input.subject != null ? input.subject : (inReplyTo ? (inReplyTo.subject.toLowerCase().startsWith('re:') ? inReplyTo.subject : `Re: ${inReplyTo.subject}`) : '');
        const draft = await this.saveMessage({
            accountId: input.accountId || DEFAULT_ACCOUNT.id,
            folder: 'drafts',
            from: input.from || normalizeAddress(DEFAULT_ACCOUNT.address),
            to: input.to != null ? input.to : (inReplyTo?.from ? [inReplyTo.from] : []),
            cc: input.cc,
            subject,
            body: input.body != null ? input.body : '',
            messageId: input.messageId,
            threadId: input.threadId || (inReplyTo?.threadId) || normalizeSubjectForThread(subject),
            draft: { isDraft: true, status: 'composing', inReplyTo: inReplyTo?.id || null },
            source: { type: 'compose', origin: inReplyTo ? `reply:${inReplyTo.id}` : 'compose', capturedAt: now() }
        });
        eventBus.emit(Events.EMAIL_DRAFT_REVIEW, draft);
        return draft;
    }

    async updateDraft(draftId, patch = {}) {
        const existing = await this.getMessage(draftId);
        if (!existing?.draft?.isDraft) throw new Error(`Draft not found: ${draftId}`);
        return this._patchMessage(draftId, {
            subject: patch.subject != null ? patch.subject : existing.subject,
            to: patch.to != null ? patch.to : existing.to,
            cc: patch.cc != null ? patch.cc : existing.cc,
            bcc: patch.bcc != null ? patch.bcc : existing.bcc,
            body: patch.body != null ? patch.body : existing.body,
            draft: { ...existing.draft, ...patch.draft, isDraft: true }
        }, { action: 'draft-edited', actor: 'user' });
    }

    /** Move a draft into the review queue (the approval gate entry). */
    async requestApproval(draftId) {
        const updated = await this._patchMessage(draftId, {
            draft: { ...(await this.getMessage(draftId))?.draft, status: 'pending-approval' }
        }, { action: 'requested-approval', actor: 'user' });
        eventBus.emit(Events.EMAIL_DRAFT_REVIEW, updated);
        return updated;
    }

    async rejectDraft(draftId, reason = '') {
        const updated = await this._patchMessage(draftId, {
            draft: { ...(await this.getMessage(draftId))?.draft, status: 'rejected', rejectionReason: cleanText(reason), rejectedAt: now() }
        }, { action: 'rejected', detail: cleanText(reason), actor: 'user' });
        eventBus.emit(Events.EMAIL_DRAFT_REVIEW, updated);
        return updated;
    }

    async approveDraft(draftId) {
        const updated = await this._patchMessage(draftId, {
            draft: { ...(await this.getMessage(draftId))?.draft, status: 'approved', approvedAt: now() }
        }, { action: 'approved', actor: 'user' });
        eventBus.emit(Events.EMAIL_DRAFT_REVIEW, updated);
        return this.sendDraft(draftId);
    }

    /**
     * The send gate. A draft can only be sent after explicit approval. Any
     * attempt to send an unapproved draft escalates it to the review queue and
     * returns { sent: false }. This is the hard approval gate before send.
     */
    async sendDraft(draftId) {
        const message = await this.getMessage(draftId);
        if (!message?.draft?.isDraft) throw new Error(`Draft not found: ${draftId}`);
        if (message.draft.status !== 'approved') {
            const escalated = await this.requestApproval(draftId);
            return { sent: false, reason: 'approval-required', status: 'pending-approval', draft: escalated };
        }
        const sent = await this._patchMessage(draftId, {
            folder: 'sent',
            date: now(),
            read: true,
            draft: { ...message.draft, status: 'sent', sentAt: now() }
        }, { action: 'sent', detail: `to ${(message.to || []).map(addr => addr.address).join(', ')}`, actor: 'user' });
        eventBus.emit(Events.EMAIL_SENT, sent);
        return { sent: true, status: 'sent', message: sent };
    }

    /** Public entry point that always enforces the approval gate. */
    attemptSend(draftId) {
        return this.sendDraft(draftId);
    }

    async listPendingDrafts() {
        const messages = await getAllRecords('emailMessages');
        return messages.filter(message => message.draft?.isDraft).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    // ── Follow-up reminders ────────────────────────────────────────────────

    async setFollowUp(messageId, { dueAt, enabled = true } = {}) {
        const followUp = { enabled: Boolean(enabled), status: 'pending', dueAt: toIso(dueAt), lastReminderAt: null };
        return this._patchMessage(messageId, { followUp }, { action: 'follow-up-set', detail: followUp.dueAt || '', actor: 'user' });
    }

    async snoozeFollowUp(messageId, until) {
        const dueAt = toIso(until) || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return this._patchMessage(messageId, { followUp: { enabled: true, status: 'snoozed', dueAt } }, { action: 'follow-up-snoozed', detail: dueAt, actor: 'user' });
    }

    async completeFollowUp(messageId) {
        return this._patchMessage(messageId, { followUp: { enabled: false, status: 'done', dueAt: null } }, { action: 'follow-up-done', actor: 'user' });
    }

    startFollowUpLoop() {
        if (this._followUpTimer) return;
        const tick = async () => {
            const nowMs = Date.now();
            const messages = await getAllRecords('emailMessages').catch(() => []);
            for (const message of messages) {
                const followUp = message.followUp;
                if (!followUp?.enabled || followUp.status === 'done' || !followUp.dueAt) continue;
                const due = new Date(followUp.dueAt).getTime();
                const key = `${message.id}:${followUp.dueAt}`;
                if (due <= nowMs && due > nowMs - 5 * 60000 && !this._firedFollowUps.has(key)) {
                    this._firedFollowUps.add(key);
                    eventBus.emit(Events.EMAIL_FOLLOWUP_DUE, { message, followUp });
                    window.dispatchEvent(new CustomEvent('synapse:emailFollowUpDue', { detail: { message, followUp } }));
                }
            }
        };
        tick();
        this._followUpTimer = setInterval(tick, 60000);
    }

    stopFollowUpLoop() {
        clearInterval(this._followUpTimer);
        this._followUpTimer = null;
    }

    // ── Cross-workspace proposal source builder ────────────────────────────

    buildSource(message) {
        return {
            id: message.id,
            type: 'email',
            kind: 'email',
            title: message.subject || '(no subject)',
            subject: message.subject,
            body: message.body || message.preview || '',
            excerpt: message.preview || summarize(message.body),
            url: '',
            from: message.from,
            date: message.date,
            dueAt: message.followUp?.dueAt || null,
            sourceRefs: [{ id: message.id, type: 'email', title: message.subject, excerpt: message.preview }]
        };
    }

    async proposeTarget(messageId, target, overrides = {}) {
        const message = await this.getMessage(messageId);
        if (!message) throw new Error(`Message not found: ${messageId}`);
        const source = this.buildSource(message);
        await this._patchMessage(messageId, {}, { action: `proposed:${target}`, detail: overrides.title || source.title, actor: 'user' });
        const detail = { ...source, ...overrides, sourceEmailId: message.id };
        const eventMap = { task: 'synapse:notesCapture', note: 'synapse:notesCapture', calendar: 'synapse:calendarCreateDraft' };
        const eventName = eventMap[target];
        if (eventName) window.dispatchEvent(new CustomEvent(eventName, { detail: { ...detail, type: target } }));
        eventBus.emit(Events.EMAIL_AGENT_PROPOSAL, { messageId, target, detail });
        return { target, detail };
    }

    // ── Import / export / seed ─────────────────────────────────────────────

    async importJson(text, { accountId = DEFAULT_ACCOUNT.id } = {}) {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : (parsed.messages || [parsed]);
        const imported = [];
        for (const raw of list) {
            imported.push(await this.saveMessage({ ...raw, accountId, folder: raw.folder || 'inbox', source: { type: 'import', origin: 'json', capturedAt: now() } }));
        }
        return imported;
    }

    async importEml(text, { accountId = DEFAULT_ACCOUNT.id } = {}) {
        const { headers, body } = parseEml(text);
        const imported = await this.saveMessage({
            accountId,
            folder: 'inbox',
            messageId: headers['message-id'],
            from: headers.from,
            to: headers.to,
            cc: headers.cc,
            subject: headers.subject || '(no subject)',
            body,
            date: headers.date,
            source: { type: 'import', origin: 'eml', capturedAt: now() }
        });
        return imported;
    }

    async exportJson(filters = {}) {
        const messages = await this.listMessages(filters);
        return JSON.stringify({ exportedAt: now(), count: messages.length, messages }, null, 2);
    }

    async seedDemoData() {
        const existing = await getAllRecords('emailMessages');
        if (existing.length) return false;
        const base = Date.now();
        const days = offset => new Date(base - offset * 24 * 60 * 60 * 1000).toISOString();
        const demo = [
            {
                accountId: DEFAULT_ACCOUNT.id, folder: 'inbox', read: false, starred: true,
                from: { name: 'Priya Nair', address: 'priya@acme.io' },
                to: [{ name: 'You', address: DEFAULT_ACCOUNT.address }],
                subject: 'Urgent: budget approval needed by Friday',
                body: "Hi team,\n\nCan you review the attached Q3 budget and approve before Friday's planning meeting? This is time-sensitive — the finance lock happens at EOD Friday.\n\nAction: confirm the engineering line item.\n\nThanks,\nPriya",
                date: days(0), source: { type: 'seed', origin: 'demo', capturedAt: now() }
            },
            {
                accountId: DEFAULT_ACCOUNT.id, folder: 'inbox', read: false,
                from: { name: 'Marcus Lee', address: 'marcus@acme.io' },
                to: [{ name: 'You', address: DEFAULT_ACCOUNT.address }],
                subject: 'Re: Urgent: budget approval needed by Friday',
                body: "Following up — could you also confirm the travel budget? Let me know if you have questions.",
                date: days(0), source: { type: 'seed', origin: 'demo', capturedAt: now() }
            },
            {
                accountId: DEFAULT_ACCOUNT.id, folder: 'inbox', read: false,
                from: { name: 'Design Weekly', address: 'newsletter@designweekly.com' },
                to: [{ name: 'You', address: DEFAULT_ACCOUNT.address }],
                subject: 'Design Weekly Digest — 10 links we loved',
                body: "This week's digest is here. Unsubscribe to stop receiving these emails. Lots of great Figma tips and a case study on onboarding flows.",
                date: days(1), source: { type: 'seed', origin: 'demo', capturedAt: now() }
            },
            {
                accountId: DEFAULT_ACCOUNT.id, folder: 'inbox', read: true,
                from: { name: 'Sam Rivera', address: 'sam@partner.co' },
                to: [{ name: 'You', address: DEFAULT_ACCOUNT.address }],
                cc: [{ name: 'Marcus Lee', address: 'marcus@acme.io' }],
                subject: 'Fwd: Partnership intro',
                body: "FYI — forwarding the intro below as discussed. Please see below and let's loop in the right folks when you're ready.",
                date: days(2), source: { type: 'seed', origin: 'demo', capturedAt: now() }
            },
            {
                accountId: DEFAULT_ACCOUNT.id, folder: 'inbox', read: true,
                from: { name: 'No-Reply', address: 'no-reply@notifs.acme.io' },
                to: [{ name: 'You', address: DEFAULT_ACCOUNT.address }],
                subject: 'Your order #4421 has shipped',
                body: "Your order has shipped and will arrive tomorrow. This is an automated notification — do not reply.",
                date: days(3), source: { type: 'seed', origin: 'demo', capturedAt: now() }
            }
        ];
        for (const message of demo) await this.saveMessage(message);
        // Pre-triage the demo inbox so the V1 triage slice is immediately visible.
        const seeded = await getAllRecords('emailMessages');
        for (const message of seeded) {
            await this.triageMessage(message.id).catch(() => {});
        }
        return true;
    }
}

export const emailService = new EmailService();
export {
    ACCOUNT_PROVIDERS, PROTOCOLS, CREDENTIAL_STATUSES, FOLDER_ROLES, SYSTEM_FOLDERS,
    TRIAGE_CATEGORIES, PRIORITIES, DRAFT_STATUSES, FOLLOWUP_STATUSES, SOURCE_TYPES, DEFAULT_ACCOUNT
};

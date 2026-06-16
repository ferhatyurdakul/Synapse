import { putRecord, putRecords, getRecord, getAllRecords, getRecordsByIndex, deleteRecord, deleteByIndex } from './idbStore.js';

const DEFAULT_PROJECT = 'default';
const DOCUMENT_TYPES = ['markdown', 'text', 'html', 'csv', 'code'];
const STATUSES = ['draft', 'published', 'archived'];

const STARTER_TEMPLATES = {
    markdown: { title: 'Untitled Markdown Document', content: '# Untitled\n\nStart writing here...', mimeType: 'text/markdown' },
    text: { title: 'Untitled Text Note', content: 'Start writing here...', mimeType: 'text/plain' },
    html: { title: 'Untitled HTML Document', content: '<article>\n  <h1>Untitled</h1>\n  <p>Start writing here...</p>\n</article>', mimeType: 'text/html' },
    csv: { title: 'Untitled CSV', content: 'column_a,column_b\nvalue,value', mimeType: 'text/csv' },
    code: { title: 'Untitled Code Note', content: '// Start writing here\n', mimeType: 'text/plain' }
};

function now() {
    return new Date().toISOString();
}

function id(prefix = 'doc') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeType(type) {
    return DOCUMENT_TYPES.includes(type) ? type : 'markdown';
}

function parseTags(value) {
    if (Array.isArray(value)) return value.map(String).map(t => t.trim()).filter(Boolean);
    return String(value || '').split(',').map(t => t.trim()).filter(Boolean);
}

function normalizeDocument(input = {}) {
    const timestamp = now();
    const type = normalizeType(input.type);
    const starter = STARTER_TEMPLATES[type];
    return {
        id: input.id || id('doc'),
        title: (input.title || starter.title).trim(),
        type,
        status: STATUSES.includes(input.status) ? input.status : 'draft',
        tags: parseTags(input.tags),
        origin: input.origin || 'manual',
        projectId: input.projectId || DEFAULT_PROJECT,
        workspaceLinks: Array.isArray(input.workspaceLinks) ? input.workspaceLinks : [],
        content: input.content ?? starter.content,
        mimeType: input.mimeType || starter.mimeType,
        archived: Boolean(input.archived),
        createdAt: input.createdAt || timestamp,
        updatedAt: timestamp,
        publishedAt: input.status === 'published' ? (input.publishedAt || timestamp) : (input.publishedAt || null),
        importedFrom: input.importedFrom || null,
        ragDocumentId: input.ragDocumentId || null,
        revision: Number(input.revision || 1)
    };
}

function searchText(doc) {
    return [doc.title, doc.type, doc.status, doc.origin, doc.projectId, ...(doc.tags || []), doc.content]
        .join(' ')
        .toLowerCase();
}

function toSuggestion(kind, content, rationale) {
    return {
        id: id('sug'),
        kind,
        content,
        rationale,
        createdAt: now(),
        status: 'pending'
    };
}

class DocumentService {
    constructor() {
        this.templates = STARTER_TEMPLATES;
    }

    listTemplates() {
        return Object.entries(this.templates).map(([type, template]) => ({ type, ...template }));
    }

    async list(options = {}) {
        let docs = await getAllRecords('documents');
        const query = String(options.query || '').trim().toLowerCase();
        const includeArchived = Boolean(options.includeArchived);

        docs = docs.filter(doc => includeArchived || !doc.archived);
        if (options.status) docs = docs.filter(doc => doc.status === options.status);
        if (options.type) docs = docs.filter(doc => doc.type === options.type);
        if (options.projectId) docs = docs.filter(doc => doc.projectId === options.projectId);
        if (query) docs = docs.filter(doc => searchText(doc).includes(query));

        docs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return docs;
    }

    async get(documentId) {
        return getRecord('documents', documentId);
    }

    async create(input = {}) {
        const doc = normalizeDocument(input);
        await putRecord('documents', doc);
        await this.snapshot(doc.id, 'created', doc);
        await this._upsertRagShadow(doc);
        return doc;
    }

    async update(documentId, patch = {}, options = {}) {
        const existing = await this.get(documentId);
        if (!existing) throw new Error(`Document not found: ${documentId}`);
        const next = normalizeDocument({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, revision: existing.revision + 1 });
        if (next.status === 'published' && existing.status !== 'published') next.publishedAt = now();
        await putRecord('documents', next);
        if (options.snapshot !== false) await this.snapshot(next.id, options.reason || 'saved', next);
        await this._upsertRagShadow(next);
        return next;
    }

    async archive(documentId, archived = true) {
        return this.update(documentId, { archived, status: archived ? 'archived' : 'draft' }, { reason: archived ? 'archived' : 'unarchived' });
    }

    async duplicate(documentId) {
        const existing = await this.get(documentId);
        if (!existing) throw new Error(`Document not found: ${documentId}`);
        return this.create({ ...existing, id: undefined, title: `${existing.title} Copy`, status: 'draft', origin: 'duplicate', createdAt: undefined, revision: 1 });
    }

    async delete(documentId) {
        await deleteByIndex('documentVersions', 'documentId', documentId);
        await deleteRecord('documents', documentId);
    }

    async snapshot(documentId, reason = 'manual', document = null) {
        const doc = document || await this.get(documentId);
        if (!doc) throw new Error(`Document not found: ${documentId}`);
        const version = {
            id: id('ver'),
            documentId,
            revision: doc.revision || 1,
            title: doc.title,
            content: doc.content,
            metadata: {
                type: doc.type,
                status: doc.status,
                tags: doc.tags,
                origin: doc.origin,
                projectId: doc.projectId,
                workspaceLinks: doc.workspaceLinks
            },
            reason,
            createdAt: now()
        };
        await putRecord('documentVersions', version);
        return version;
    }

    async versions(documentId) {
        const versions = await getRecordsByIndex('documentVersions', 'documentId', documentId);
        versions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return versions;
    }

    async restoreVersion(documentId, versionId) {
        const version = await getRecord('documentVersions', versionId);
        if (!version || version.documentId !== documentId) throw new Error('Version not found for document');
        return this.update(documentId, {
            title: version.title,
            content: version.content,
            ...version.metadata
        }, { reason: `restored ${version.revision}` });
    }

    compareVersions(left, right) {
        const leftLines = String(left?.content || '').split('\n');
        const rightLines = String(right?.content || '').split('\n');
        const max = Math.max(leftLines.length, rightLines.length);
        const changes = [];
        for (let i = 0; i < max; i++) {
            if (leftLines[i] !== rightLines[i]) {
                changes.push({ line: i + 1, before: leftLines[i] || '', after: rightLines[i] || '' });
            }
        }
        return changes;
    }

    async importFiles(fileList) {
        const docs = [];
        for (const file of Array.from(fileList || [])) {
            const content = await file.text();
            const type = this._typeFromFile(file);
            docs.push(await this.create({
                title: file.name.replace(/\.[^.]+$/, '') || file.name,
                type,
                content,
                mimeType: file.type || STARTER_TEMPLATES[type].mimeType,
                origin: 'upload',
                importedFrom: file.name
            }));
        }
        return docs;
    }

    exportDocument(doc) {
        const extension = doc.type === 'markdown' ? 'md' : doc.type === 'text' ? 'txt' : doc.type;
        const blob = new Blob([doc.content || ''], { type: doc.mimeType || 'text/plain' });
        return { blob, filename: `${doc.title || 'document'}.${extension}`.replace(/[\\/:*?"<>|]+/g, '-') };
    }

    exportBundle(docs) {
        const payload = { exportedAt: now(), documents: docs };
        return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    }

    async makeSuggestion(documentId, kind) {
        const doc = await this.get(documentId);
        if (!doc) throw new Error(`Document not found: ${documentId}`);
        const content = doc.content || '';
        const lines = content.split('\n').filter(Boolean);
        if (kind === 'summarize') {
            return toSuggestion(kind, lines.slice(0, 6).join('\n') || content.slice(0, 600), 'Draft summary from the first substantive lines.');
        }
        if (kind === 'outline') {
            const headings = lines.filter(line => /^#{1,6}\s+/.test(line)).map(line => `- ${line.replace(/^#+\s*/, '')}`);
            return toSuggestion(kind, headings.join('\n') || lines.slice(0, 8).map(line => `- ${line.slice(0, 90)}`).join('\n'), 'Extracted outline from headings or leading lines.');
        }
        if (kind === 'rewrite') {
            return toSuggestion(kind, content.replace(/\s+$/gm, '').trim(), 'Whitespace-normalized rewrite draft.');
        }
        if (kind === 'compare') {
            const versions = await this.versions(documentId);
            if (versions.length < 2) return toSuggestion(kind, 'No previous version to compare yet.', 'Create another snapshot to compare revisions.');
            const changes = this.compareVersions(versions[1], versions[0]).slice(0, 30);
            return toSuggestion(kind, changes.map(c => `L${c.line}: - ${c.before}\nL${c.line}: + ${c.after}`).join('\n') || 'No textual changes.', 'Compared latest two snapshots.');
        }
        return toSuggestion('suggest', `${content}\n\n<!-- Suggestion: clarify the goal, audience, and next action. -->`, 'Appends a visible editing suggestion.');
    }

    async acceptSuggestion(documentId, suggestion) {
        if (!suggestion) return this.get(documentId);
        if (['rewrite', 'suggest'].includes(suggestion.kind)) {
            return this.update(documentId, { content: suggestion.content }, { reason: `accepted ${suggestion.kind}` });
        }
        const doc = await this.get(documentId);
        const appended = `${doc.content || ''}\n\n## ${suggestion.kind[0].toUpperCase()}${suggestion.kind.slice(1)}\n${suggestion.content}`.trim();
        return this.update(documentId, { content: appended }, { reason: `accepted ${suggestion.kind}` });
    }

    async _upsertRagShadow(doc) {
        // Reuse the existing RAG stores lightly by publishing a searchable shadow record.
        // Embeddings/chunks remain owned by ragService; this keeps document-library items discoverable by ID.
        try {
            const collectionId = 'document-library';
            await putRecord('ragCollections', { id: collectionId, name: 'Document Library', createdAt: doc.createdAt, updatedAt: doc.updatedAt });
            await putRecord('ragDocuments', {
                id: `doclib:${doc.id}`,
                collectionId,
                title: doc.title,
                content: doc.content,
                metadata: { source: 'document-library', type: doc.type, tags: doc.tags, status: doc.status },
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt
            });
        } catch (err) {
            console.warn('[DocumentService] RAG shadow update skipped:', err);
        }
    }

    _typeFromFile(file) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
        if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
        if (name.endsWith('.csv')) return 'csv';
        if (/\.(js|ts|py|css|json|yaml|yml|toml|sh|sql)$/.test(name)) return 'code';
        return 'text';
    }
}

export const documentService = new DocumentService();
export { DOCUMENT_TYPES, STATUSES };

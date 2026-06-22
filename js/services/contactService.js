/**
 * contactService — local contacts / people workspace data layer.
 *
 * Keeps a stable client-side contact model in IndexedDB with lightweight
 * import/export helpers and review-first AI assist utilities.
 */
import { putRecord, getRecord, getAllRecords, deleteRecord } from './idbStore.js';

const STORE = 'contacts';
const LINK_TYPES = ['email', 'calendar', 'note', 'task', 'document', 'chat', 'url', 'other'];
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

function now() {
    return new Date().toISOString();
}

function makeId(prefix = 'contact') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function clean(value) {
    return String(value || '').trim();
}

function lower(value) {
    return clean(value).toLowerCase();
}

function list(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean);
    return String(value || '').split(/[\n,;]/).map(clean).filter(Boolean);
}

function unique(values) {
    return Array.from(new Set(list(values).map(clean))).filter(Boolean);
}

function normalizeEmails(value) {
    return unique(value).map(email => email.toLowerCase()).filter(email => email.includes('@'));
}

function normalizePhones(value) {
    return unique(value).map(phone => phone.replace(/\s+/g, ' ').trim());
}

function normalizeLinks(value = []) {
    const links = Array.isArray(value) ? value : [value].filter(Boolean);
    return links
        .map(link => typeof link === 'string' ? { title: link, url: link } : link)
        .filter(Boolean)
        .map(link => ({
            id: link.id || makeId('link'),
            type: LINK_TYPES.includes(link.type) ? link.type : 'other',
            title: clean(link.title || link.label || link.url || link.id || 'Linked item'),
            targetId: clean(link.targetId || link.idRef || ''),
            url: clean(link.url || ''),
            excerpt: clean(link.excerpt || link.notes || ''),
            createdAt: link.createdAt || now()
        }))
        .filter(link => link.title || link.targetId || link.url);
}

export function normalizeContact(input = {}, existing = null) {
    const ts = now();
    const name = clean(input.name || input.fullName || existing?.name || 'Unnamed Person');
    const emails = normalizeEmails(input.emails || input.email || existing?.emails || []);
    const phones = normalizePhones(input.phones || input.phone || existing?.phones || []);
    const tags = unique([...(existing?.tags || []), ...list(input.tags)]).map(tag => tag.toLowerCase());
    const links = normalizeLinks(input.links || input.linkedArtifacts || existing?.links || []);

    return {
        id: input.id || existing?.id || makeId(),
        name,
        displayName: clean(input.displayName || name),
        role: clean(input.role || existing?.role || ''),
        organization: clean(input.organization || input.company || existing?.organization || ''),
        emails,
        phones,
        tags,
        notes: clean(input.notes || existing?.notes || ''),
        links,
        favorite: Boolean(input.favorite ?? existing?.favorite ?? false),
        archived: Boolean(input.archived ?? existing?.archived ?? false),
        source: clean(input.source || existing?.source || 'manual'),
        externalSync: {
            provider: clean(input.externalSync?.provider || existing?.externalSync?.provider || ''),
            remoteId: clean(input.externalSync?.remoteId || existing?.externalSync?.remoteId || ''),
            enabled: Boolean(input.externalSync?.enabled ?? existing?.externalSync?.enabled ?? false),
            note: input.externalSync?.note || existing?.externalSync?.note || 'External sync is reserved for a future CardDAV/provider integration.'
        },
        createdAt: existing?.createdAt || input.createdAt || ts,
        updatedAt: ts
    };
}

export async function listContacts({ query = '', includeArchived = false } = {}) {
    const contacts = await getAllRecords(STORE);
    const q = lower(query);
    return contacts
        .filter(contact => includeArchived || !contact.archived)
        .filter(contact => {
            if (!q) return true;
            const haystack = [
                contact.name,
                contact.displayName,
                contact.role,
                contact.organization,
                ...(contact.emails || []),
                ...(contact.phones || []),
                ...(contact.tags || []),
                contact.notes
            ].join(' ').toLowerCase();
            return haystack.includes(q);
        })
        .sort((a, b) => {
            if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
            return lower(a.name).localeCompare(lower(b.name));
        });
}

export async function getContact(id) {
    return getRecord(STORE, id);
}

export async function saveContact(input) {
    const existing = input.id ? await getContact(input.id) : null;
    const contact = normalizeContact(input, existing);
    await putRecord(STORE, contact);
    return contact;
}

export async function removeContact(id) {
    await deleteRecord(STORE, id);
}

export async function archiveContact(id, archived = true) {
    const contact = await getContact(id);
    if (!contact) return null;
    return saveContact({ ...contact, archived });
}

export async function findDuplicateCandidates(input, { excludeId = null } = {}) {
    const contact = normalizeContact(input);
    const contacts = await getAllRecords(STORE);
    const nameKey = lower(contact.name);
    const emailSet = new Set(contact.emails || []);
    const phoneSet = new Set(contact.phones || []);

    return contacts
        .filter(candidate => candidate.id !== excludeId)
        .map(candidate => {
            let score = 0;
            const reasons = [];
            if (nameKey && lower(candidate.name) === nameKey) {
                score += 3;
                reasons.push('same name');
            }
            const emailHits = (candidate.emails || []).filter(email => emailSet.has(lower(email)));
            if (emailHits.length) {
                score += 5 + emailHits.length;
                reasons.push(`shared email: ${emailHits.join(', ')}`);
            }
            const phoneHits = (candidate.phones || []).filter(phone => phoneSet.has(phone));
            if (phoneHits.length) {
                score += 4 + phoneHits.length;
                reasons.push(`shared phone: ${phoneHits.join(', ')}`);
            }
            return { contact: candidate, score, reasons };
        })
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score);
}

export async function mergeContacts(primaryId, duplicateId) {
    const primary = await getContact(primaryId);
    const duplicate = await getContact(duplicateId);
    if (!primary || !duplicate) throw new Error('Both contacts must exist to merge');

    const merged = normalizeContact({
        ...primary,
        emails: unique([...(primary.emails || []), ...(duplicate.emails || [])]),
        phones: unique([...(primary.phones || []), ...(duplicate.phones || [])]),
        tags: unique([...(primary.tags || []), ...(duplicate.tags || [])]),
        notes: [primary.notes, duplicate.notes && `Merged note from ${duplicate.name}: ${duplicate.notes}`].filter(Boolean).join('\n\n'),
        links: [...(primary.links || []), ...(duplicate.links || [])],
        organization: primary.organization || duplicate.organization,
        role: primary.role || duplicate.role,
        favorite: primary.favorite || duplicate.favorite,
        id: primary.id
    }, primary);
    await putRecord(STORE, merged);
    await deleteRecord(STORE, duplicateId);
    return merged;
}

export function summarizeRelationship(contact = {}) {
    const pieces = [];
    pieces.push(`${contact.name || 'This person'}${contact.organization ? ` works with ${contact.organization}` : ''}${contact.role ? ` as ${contact.role}` : ''}.`);
    if (contact.tags?.length) pieces.push(`Tags: ${contact.tags.join(', ')}.`);
    if (contact.links?.length) {
        const byType = contact.links.reduce((acc, link) => {
            acc[link.type] = (acc[link.type] || 0) + 1;
            return acc;
        }, {});
        pieces.push(`Linked artifacts: ${Object.entries(byType).map(([type, count]) => `${count} ${type}`).join(', ')}.`);
    }
    if (contact.notes) pieces.push(`Notes: ${contact.notes}`);
    return pieces.join(' ');
}

export function extractPeopleForReview(text = '') {
    const source = String(text || '');
    const emails = Array.from(new Set(source.match(EMAIL_RE) || [])).map(email => email.toLowerCase());
    const phones = Array.from(new Set(source.match(PHONE_RE) || [])).map(clean);
    const candidates = new Map();

    for (const email of emails) {
        const local = email.split('@')[0].replace(/[._-]+/g, ' ');
        const guessedName = local.split(' ').filter(part => part.length > 1).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
        candidates.set(email, normalizeContact({ name: guessedName || email, emails: [email], source: 'ai-review' }));
    }

    const nameMatches = source.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g) || [];
    for (const name of nameMatches.slice(0, 12)) {
        const key = lower(name);
        if (!Array.from(candidates.values()).some(contact => lower(contact.name) === key)) {
            candidates.set(key, normalizeContact({ name, source: 'ai-review' }));
        }
    }

    const first = candidates.values().next().value;
    if (first && phones.length && !first.phones.length) first.phones = phones;

    return {
        candidates: Array.from(candidates.values()),
        reviewRequired: true,
        note: 'Review extracted people before saving. Nothing is persisted automatically.'
    };
}

export function exportContacts(contacts, format = 'json') {
    const items = Array.isArray(contacts) ? contacts : [];
    if (format === 'csv') {
        const header = ['name', 'organization', 'role', 'emails', 'phones', 'tags', 'notes'];
        const rows = items.map(contact => header.map(key => {
            const value = Array.isArray(contact[key]) ? contact[key].join('; ') : (contact[key] || '');
            return `"${String(value).replace(/"/g, '""')}"`;
        }).join(','));
        return [header.join(','), ...rows].join('\n');
    }
    if (format === 'vcard') {
        return items.map(contact => [
            'BEGIN:VCARD',
            'VERSION:3.0',
            `FN:${contact.name || ''}`,
            contact.organization ? `ORG:${contact.organization}` : '',
            ...(contact.emails || []).map(email => `EMAIL:${email}`),
            ...(contact.phones || []).map(phone => `TEL:${phone}`),
            contact.notes ? `NOTE:${contact.notes.replace(/\n/g, '\\n')}` : '',
            'END:VCARD'
        ].filter(Boolean).join('\n')).join('\n');
    }
    return JSON.stringify(items, null, 2);
}

export function parseImportedContacts(text, format = 'json') {
    const body = String(text || '').trim();
    if (!body) return [];
    if (format === 'csv') {
        const [headerLine, ...lines] = body.split(/\r?\n/).filter(Boolean);
        const headers = headerLine.split(',').map(h => h.replace(/^"|"$/g, '').trim());
        return lines.map(line => {
            const cells = line.match(/("(?:""|[^"])*"|[^,]*)/g).filter((_, i) => i % 2 === 0).map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
            const row = Object.fromEntries(headers.map((header, idx) => [header, cells[idx] || '']));
            return normalizeContact({ ...row, emails: row.emails, phones: row.phones, tags: row.tags, source: 'import' });
        });
    }
    if (format === 'vcard') {
        return body.split(/END:VCARD/i).map(card => {
            const name = (card.match(/^FN:(.*)$/mi) || [])[1];
            const org = (card.match(/^ORG:(.*)$/mi) || [])[1];
            const note = (card.match(/^NOTE:(.*)$/mi) || [])[1];
            const emails = Array.from(card.matchAll(/^EMAIL[^:]*:(.*)$/gmi)).map(match => match[1]);
            const phones = Array.from(card.matchAll(/^TEL[^:]*:(.*)$/gmi)).map(match => match[1]);
            return name || emails.length ? normalizeContact({ name: name || emails[0], organization: org, emails, phones, notes: note, source: 'import' }) : null;
        }).filter(Boolean);
    }
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(item => normalizeContact({ ...item, source: item.source || 'import' }));
}

export async function importContacts(text, format = 'json') {
    const parsed = parseImportedContacts(text, format);
    const saved = [];
    const duplicates = [];
    for (const contact of parsed) {
        const matches = await findDuplicateCandidates(contact);
        if (matches.length) {
            duplicates.push({ contact, matches });
        } else {
            saved.push(await saveContact(contact));
        }
    }
    return { saved, duplicates, reviewRequired: duplicates.length > 0 };
}

export const contactService = {
    listContacts,
    getContact,
    saveContact,
    removeContact,
    archiveContact,
    findDuplicateCandidates,
    mergeContacts,
    summarizeRelationship,
    extractPeopleForReview,
    exportContacts,
    parseImportedContacts,
    importContacts
};

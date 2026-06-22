import { contactService } from '../services/contactService.js';
import { toast } from './toast.js';

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function lines(value) {
    if (Array.isArray(value)) return value.join('\n');
    return String(value || '');
}

function splitLines(value) {
    return String(value || '').split(/[\n,;]/).map(item => item.trim()).filter(Boolean);
}

function linkRows(links = []) {
    if (!links.length) return '<p class="ct-empty-inline">No linked artifacts yet.</p>';
    return links.map(link => `
        <div class="ct-link-row">
            <span class="ct-pill">${escapeHtml(link.type)}</span>
            <div>
                <strong>${escapeHtml(link.title)}</strong>
                ${link.url ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.url)}</a>` : ''}
                ${link.excerpt ? `<small>${escapeHtml(link.excerpt)}</small>` : ''}
            </div>
        </div>
    `).join('');
}

export function createContactsPanel() {
    return new ContactsPanel();
}

class ContactsPanel {
    constructor() {
        this.contacts = [];
        this.selectedId = null;
        this.query = '';
        this.editing = false;
        this.pendingExtracted = [];
        this.el = document.createElement('section');
        this.el.className = 'ct-panel';
        this.el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(this.el);
        this.render();
    }

    isOpen() {
        return this.el.classList.contains('open');
    }

    async open() {
        this.el.classList.add('open');
        this.el.setAttribute('aria-hidden', 'false');
        await this.load();
        setTimeout(() => this.el.querySelector('[data-ct-search]')?.focus(), 0);
    }

    close() {
        this.el.classList.remove('open');
        this.el.setAttribute('aria-hidden', 'true');
        this.editing = false;
        this.pendingExtracted = [];
    }

    async load() {
        this.contacts = await contactService.listContacts({ query: this.query });
        if (!this.selectedId && this.contacts.length) this.selectedId = this.contacts[0].id;
        if (this.selectedId && !this.contacts.some(contact => contact.id === this.selectedId)) {
            this.selectedId = this.contacts[0]?.id || null;
        }
        this.render();
    }

    selected() {
        return this.contacts.find(contact => contact.id === this.selectedId) || null;
    }

    render() {
        const selected = this.selected();
        this.el.innerHTML = `
            <div class="ct-backdrop" data-ct-close></div>
            <div class="ct-shell" role="dialog" aria-modal="true" aria-label="Contacts and people workspace">
                <header class="ct-header">
                    <div>
                        <p class="ct-kicker">People Workspace</p>
                        <h2>Contacts</h2>
                        <span>${this.contacts.length} visible · local-first IndexedDB</span>
                    </div>
                    <button class="ct-icon-btn" data-ct-close title="Close" aria-label="Close">×</button>
                </header>
                <div class="ct-toolbar">
                    <input data-ct-search type="search" placeholder="Search names, emails, tags, notes…" value="${escapeHtml(this.query)}">
                    <button data-ct-new>New Contact</button>
                    <button data-ct-import>Import</button>
                    <button data-ct-export>Export</button>
                </div>
                <main class="ct-main">
                    <aside class="ct-list">
                        ${this.contacts.length ? this.contacts.map(contact => this.renderListItem(contact)).join('') : '<div class="ct-empty">No contacts yet. Create one or extract people from text.</div>'}
                    </aside>
                    <section class="ct-detail">
                        ${this.editing ? this.renderEditor(selected) : this.renderDetail(selected)}
                    </section>
                </main>
            </div>
        `;
        this.bind();
    }

    renderListItem(contact) {
        const active = contact.id === this.selectedId ? 'active' : '';
        const initials = (contact.name || '?').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
        return `
            <button class="ct-list-item ${active}" data-ct-select="${escapeHtml(contact.id)}">
                <span class="ct-avatar">${escapeHtml(initials)}</span>
                <span>
                    <strong>${escapeHtml(contact.name)}</strong>
                    <small>${escapeHtml(contact.organization || contact.emails?.[0] || 'No organization')}</small>
                </span>
                ${contact.favorite ? '<span class="ct-star">★</span>' : ''}
            </button>
        `;
    }

    renderDetail(contact) {
        if (!contact) {
            return `
                <div class="ct-empty ct-empty-large">
                    <h3>Build a reusable people layer</h3>
                    <p>Store names, emails, phones, tags, notes, and links to emails, calendar events, notes, tasks, documents, or URLs.</p>
                    <button data-ct-new>Create the first contact</button>
                </div>
                ${this.renderAiBox()}
            `;
        }
        return `
            <div class="ct-card">
                <div class="ct-person-head">
                    <span class="ct-avatar big">${escapeHtml(contact.name.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase())}</span>
                    <div>
                        <h3>${escapeHtml(contact.name)}</h3>
                        <p>${escapeHtml([contact.role, contact.organization].filter(Boolean).join(' · ') || 'Person')}</p>
                        <div class="ct-tags">${(contact.tags || []).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
                    </div>
                </div>
                <div class="ct-actions">
                    <button data-ct-edit>Edit</button>
                    <button data-ct-duplicate>Find Duplicates</button>
                    <button data-ct-summary>Summarize</button>
                    <button data-ct-archive>${contact.archived ? 'Unarchive' : 'Archive'}</button>
                </div>
                <div class="ct-grid">
                    <div><label>Email</label><p>${escapeHtml((contact.emails || []).join('\n') || '—')}</p></div>
                    <div><label>Phone</label><p>${escapeHtml((contact.phones || []).join('\n') || '—')}</p></div>
                    <div><label>External Sync</label><p>${escapeHtml(contact.externalSync?.enabled ? `${contact.externalSync.provider} enabled` : 'Not enabled; CardDAV/provider sync later')}</p></div>
                </div>
                <label>Notes</label>
                <p class="ct-notes">${escapeHtml(contact.notes || 'No notes yet.')}</p>
                <label>Linked workspace artifacts</label>
                <div class="ct-links">${linkRows(contact.links)}</div>
            </div>
            ${this.renderAiBox()}
        `;
    }

    renderEditor(contact) {
        const c = contact || { name: '', organization: '', role: '', emails: [], phones: [], tags: [], notes: '', links: [] };
        return `
            <form class="ct-card ct-form" data-ct-form>
                <h3>${c.id ? 'Edit Contact' : 'New Contact'}</h3>
                <label>Name <input name="name" required value="${escapeHtml(c.name)}"></label>
                <div class="ct-two">
                    <label>Organization <input name="organization" value="${escapeHtml(c.organization)}"></label>
                    <label>Role <input name="role" value="${escapeHtml(c.role)}"></label>
                </div>
                <label>Emails <textarea name="emails" rows="2" placeholder="one per line">${escapeHtml(lines(c.emails))}</textarea></label>
                <label>Phones <textarea name="phones" rows="2" placeholder="one per line">${escapeHtml(lines(c.phones))}</textarea></label>
                <label>Tags <input name="tags" value="${escapeHtml((c.tags || []).join(', '))}" placeholder="family, work, project-x"></label>
                <label>Notes <textarea name="notes" rows="4">${escapeHtml(c.notes)}</textarea></label>
                <fieldset class="ct-link-editor">
                    <legend>Add linked artifact</legend>
                    <select name="linkType">
                        ${['email', 'calendar', 'note', 'task', 'document', 'chat', 'url', 'other'].map(type => `<option value="${type}">${type}</option>`).join('')}
                    </select>
                    <input name="linkTitle" placeholder="Title">
                    <input name="linkUrl" placeholder="URL or local reference">
                </fieldset>
                <label class="ct-check"><input name="favorite" type="checkbox" ${c.favorite ? 'checked' : ''}> Favorite</label>
                <div class="ct-actions">
                    <button type="submit">Save</button>
                    <button type="button" data-ct-cancel>Cancel</button>
                </div>
            </form>
        `;
    }

    renderAiBox() {
        return `
            <div class="ct-card ct-ai">
                <h3>AI assist — review before save</h3>
                <p>Paste email, notes, or meeting text. Synapse extracts people locally as draft candidates; you choose what to save.</p>
                <textarea data-ct-extract-text rows="4" placeholder="Paste context containing names, emails, phones…"></textarea>
                <div class="ct-actions"><button data-ct-extract>Extract People</button></div>
                <div class="ct-extracted">
                    ${this.pendingExtracted.map((contact, idx) => `
                        <div class="ct-extract-row">
                            <span><strong>${escapeHtml(contact.name)}</strong><small>${escapeHtml((contact.emails || []).join(', ') || 'No email')}</small></span>
                            <button data-ct-save-extracted="${idx}">Save</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    bind() {
        this.el.querySelectorAll('[data-ct-close]').forEach(btn => btn.addEventListener('click', () => this.close()));
        this.el.querySelector('[data-ct-search]')?.addEventListener('input', async (event) => {
            this.query = event.target.value;
            await this.load();
        });
        this.el.querySelectorAll('[data-ct-select]').forEach(btn => btn.addEventListener('click', () => {
            this.selectedId = btn.dataset.ctSelect;
            this.editing = false;
            this.render();
        }));
        this.el.querySelectorAll('[data-ct-new]').forEach(btn => btn.addEventListener('click', () => {
            this.selectedId = null;
            this.editing = true;
            this.render();
        }));
        this.el.querySelector('[data-ct-edit]')?.addEventListener('click', () => {
            this.editing = true;
            this.render();
        });
        this.el.querySelector('[data-ct-cancel]')?.addEventListener('click', () => {
            this.editing = false;
            this.render();
        });
        this.el.querySelector('[data-ct-form]')?.addEventListener('submit', event => this.saveForm(event));
        this.el.querySelector('[data-ct-archive]')?.addEventListener('click', async () => {
            const contact = this.selected();
            if (!contact) return;
            await contactService.archiveContact(contact.id, !contact.archived);
            toast.success(contact.archived ? 'Contact unarchived' : 'Contact archived');
            await this.load();
        });
        this.el.querySelector('[data-ct-duplicate]')?.addEventListener('click', () => this.showDuplicates());
        this.el.querySelector('[data-ct-summary]')?.addEventListener('click', () => {
            const contact = this.selected();
            if (contact) toast.info(contactService.summarizeRelationship(contact));
        });
        this.el.querySelector('[data-ct-export]')?.addEventListener('click', () => this.exportJson());
        this.el.querySelector('[data-ct-import]')?.addEventListener('click', () => this.importJson());
        this.el.querySelector('[data-ct-extract]')?.addEventListener('click', () => {
            const text = this.el.querySelector('[data-ct-extract-text]')?.value || '';
            const result = contactService.extractPeopleForReview(text);
            this.pendingExtracted = result.candidates;
            this.render();
        });
        this.el.querySelectorAll('[data-ct-save-extracted]').forEach(btn => btn.addEventListener('click', async () => {
            const contact = this.pendingExtracted[Number(btn.dataset.ctSaveExtracted)];
            if (!contact) return;
            const matches = await contactService.findDuplicateCandidates(contact);
            if (matches.length && !window.confirm(`Possible duplicate: ${matches[0].contact.name}. Save anyway?`)) return;
            const saved = await contactService.saveContact(contact);
            this.selectedId = saved.id;
            toast.success('Extracted contact saved');
            await this.load();
        }));
    }

    async saveForm(event) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const contact = this.selected();
        const linkTitle = form.get('linkTitle');
        const linkUrl = form.get('linkUrl');
        const links = [...(contact?.links || [])];
        if (linkTitle || linkUrl) {
            links.push({ type: form.get('linkType'), title: linkTitle || linkUrl, url: linkUrl });
        }
        const input = {
            id: contact?.id,
            name: form.get('name'),
            organization: form.get('organization'),
            role: form.get('role'),
            emails: splitLines(form.get('emails')),
            phones: splitLines(form.get('phones')),
            tags: splitLines(form.get('tags')),
            notes: form.get('notes'),
            favorite: form.get('favorite') === 'on',
            links
        };
        const duplicates = await contactService.findDuplicateCandidates(input, { excludeId: contact?.id });
        if (duplicates.length && !window.confirm(`Possible duplicate: ${duplicates[0].contact.name} (${duplicates[0].reasons.join(', ')}). Save anyway?`)) return;
        const saved = await contactService.saveContact(input);
        this.selectedId = saved.id;
        this.editing = false;
        toast.success('Contact saved');
        await this.load();
    }

    async showDuplicates() {
        const contact = this.selected();
        if (!contact) return;
        const matches = await contactService.findDuplicateCandidates(contact, { excludeId: contact.id });
        if (!matches.length) {
            toast.info('No duplicate candidates found');
            return;
        }
        const top = matches[0];
        if (window.confirm(`Merge ${top.contact.name} into ${contact.name}? Reasons: ${top.reasons.join(', ')}`)) {
            await contactService.mergeContacts(contact.id, top.contact.id);
            toast.success('Contacts merged');
            await this.load();
        }
    }

    exportJson() {
        const data = contactService.exportContacts(this.contacts, 'json');
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'synapse-contacts.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    importJson() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.csv,.vcf,text/csv,application/json,text/vcard';
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) return;
            const text = await file.text();
            const ext = file.name.split('.').pop().toLowerCase();
            const format = ext === 'csv' ? 'csv' : (ext === 'vcf' ? 'vcard' : 'json');
            const result = await contactService.importContacts(text, format);
            toast.success(`Imported ${result.saved.length} contacts${result.duplicates.length ? `; ${result.duplicates.length} need duplicate review` : ''}`);
            await this.load();
        });
        input.click();
    }
}

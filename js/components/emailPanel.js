import { emailService, TRIAGE_CATEGORIES, PRIORITIES } from '../services/emailService.js';
import { eventBus, Events } from '../utils/eventBus.js';
import { escapeHtml } from '../utils/markdown.js';
import { toast } from './toast.js';

function fmtDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function addr(value) {
    if (!value) return '';
    return value.name ? `${value.name} <${value.address}>` : value.address || '';
}

function dtLocal(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

class EmailPanel {
    constructor() {
        this.opened = false;
        this.accounts = [];
        this.folders = [];
        this.threads = [];
        this.messages = [];
        this.drafts = [];
        this.filters = { folder: 'inbox', query: '', category: '', priority: '', unread: false };
        this.activeThreadId = null;
        this.activeMessage = null;
        this._renderShell();
        this._bindExternalHooks();
    }

    isOpen() { return this.opened; }

    _renderShell() {
        const modal = document.createElement('div');
        modal.id = 'email-modal';
        modal.className = 'email-modal';
        modal.innerHTML = `
            <div class="email-overlay"></div>
            <div class="email-panel">
                <header class="email-header">
                    <div>
                        <h2><i data-lucide="mail" class="icon"></i> Email Workspace</h2>
                        <p>Local-first inbox triage, draft review gates, follow-ups, and email-to-workspace proposals.</p>
                    </div>
                    <button id="email-close" class="email-close" type="button" aria-label="Close">&times;</button>
                </header>
                <div class="email-body">
                    <aside class="email-sidebar">
                        <section class="email-card email-account-card">
                            <div class="email-card-title"><strong>Account</strong><button id="email-save-account" type="button">Save</button></div>
                            <input id="email-account-name" placeholder="Account name">
                            <input id="email-account-address" placeholder="Email address">
                            <select id="email-account-provider"><option value="local">Local</option><option value="gmail">Gmail</option><option value="outlook">Outlook</option><option value="imap">IMAP</option><option value="other">Other</option></select>
                            <div class="email-grid-2"><input id="email-imap-host" placeholder="IMAP host"><input id="email-imap-port" type="number" placeholder="993"></div>
                            <div class="email-grid-2"><input id="email-smtp-host" placeholder="SMTP host"><input id="email-smtp-port" type="number" placeholder="587"></div>
                            <input id="email-signature" placeholder="Signature">
                            <p id="email-credential-status" class="email-muted"></p>
                            <button id="email-validate" type="button">Validate Credentials (placeholder)</button>
                        </section>
                        <section class="email-card">
                            <div class="email-card-title"><strong>Mailboxes</strong><button id="email-compose" type="button">Compose</button></div>
                            <div id="email-folder-list" class="email-folder-list"></div>
                        </section>
                        <section class="email-card">
                            <div class="email-card-title"><strong>Filters</strong><button id="email-triage-visible" type="button">Triage visible</button></div>
                            <input id="email-search" type="search" placeholder="Search subject, sender, body...">
                            <label><input id="email-unread" type="checkbox"> Unread only</label>
                            <select id="email-category"><option value="">All categories</option>${TRIAGE_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
                            <select id="email-priority"><option value="">All priorities</option>${PRIORITIES.map(p => `<option value="${p}">${p}</option>`).join('')}</select>
                        </section>
                        <section class="email-card">
                            <div class="email-card-title"><strong>Draft approvals</strong></div>
                            <div id="email-draft-list" class="email-draft-list"></div>
                        </section>
                    </aside>
                    <main class="email-main">
                        <section class="email-thread-list" id="email-thread-list"></section>
                        <section class="email-reader" id="email-reader"><div class="email-empty">Select a thread to triage.</div></section>
                    </main>
                </div>
            </div>`;
        document.body.appendChild(modal);
        this.modal = modal;
        this._bindShellEvents();
    }

    _bindShellEvents() {
        this.modal.querySelector('#email-close').addEventListener('click', () => this.close());
        this.modal.querySelector('.email-overlay').addEventListener('click', () => this.close());
        this.modal.querySelector('#email-search').addEventListener('input', e => { this.filters.query = e.target.value; this._load(); });
        this.modal.querySelector('#email-unread').addEventListener('change', e => { this.filters.unread = e.target.checked; this._load(); });
        this.modal.querySelector('#email-category').addEventListener('change', e => { this.filters.category = e.target.value; this._load(); });
        this.modal.querySelector('#email-priority').addEventListener('change', e => { this.filters.priority = e.target.value; this._load(); });
        this.modal.querySelector('#email-compose').addEventListener('click', () => this._compose());
        this.modal.querySelector('#email-save-account').addEventListener('click', () => this._saveAccount());
        this.modal.querySelector('#email-validate').addEventListener('click', () => this._validateAccount());
        this.modal.querySelector('#email-triage-visible').addEventListener('click', () => this._triageVisible());
        eventBus.on(Events.EMAIL_MESSAGE_SAVED, () => this.opened && this._load());
        eventBus.on(Events.EMAIL_ACCOUNT_SAVED, () => this.opened && this._load());
        eventBus.on(Events.EMAIL_FOLLOWUP_DUE, ({ message }) => toast.warning(`Email follow-up due: ${message.subject}`));
    }

    _bindExternalHooks() {
        window.SynapseEmail = {
            open: () => this.open(),
            compose: input => this._compose(input),
            propose: (messageId, target, overrides) => emailService.proposeTarget(messageId, target, overrides)
        };
    }

    async open() {
        this.opened = true;
        this.modal.classList.add('open');
        await emailService.init();
        await this._load();
        refreshIcons();
    }

    close() {
        this.opened = false;
        this.modal.classList.remove('open');
    }

    async _load() {
        this.accounts = await emailService.listAccounts();
        this.folders = await emailService.listFolders(this.accounts[0]?.id);
        this.threads = await emailService.listThreads(this.filters);
        this.drafts = await emailService.listPendingDrafts();
        if (!this.activeThreadId && this.threads[0]) this.activeThreadId = this.threads[0].threadId;
        this.messages = this.activeThreadId ? await emailService.listMessages({ threadId: this.activeThreadId }) : [];
        this.activeMessage = this.messages[this.messages.length - 1] || null;
        this._renderAccount();
        this._renderFolders();
        this._renderThreads();
        this._renderReader();
        this._renderDrafts();
        refreshIcons();
    }

    _renderAccount() {
        const account = this.accounts[0];
        if (!account) return;
        this.modal.querySelector('#email-account-name').value = account.name || '';
        this.modal.querySelector('#email-account-address').value = account.address || '';
        this.modal.querySelector('#email-account-provider').value = account.provider || 'local';
        this.modal.querySelector('#email-imap-host').value = account.imap?.host || '';
        this.modal.querySelector('#email-imap-port').value = account.imap?.port || '';
        this.modal.querySelector('#email-smtp-host').value = account.smtp?.host || '';
        this.modal.querySelector('#email-smtp-port').value = account.smtp?.port || '';
        this.modal.querySelector('#email-signature').value = account.routing?.signature || '';
        this.modal.querySelector('#email-credential-status').textContent = `Credential status: ${account.credentials?.status || 'placeholder'} — V1 stores settings locally and performs no network login.`;
    }

    _renderFolders() {
        const counts = this.threads.reduce((acc, t) => { acc[t.latest.folder] = (acc[t.latest.folder] || 0) + 1; return acc; }, {});
        this.modal.querySelector('#email-folder-list').innerHTML = this.folders.map(folder => `
            <button type="button" data-folder="${escapeHtml(folder.role)}" class="${this.filters.folder === folder.role ? 'active' : ''}">
                <span>${escapeHtml(folder.name)}</span><span>${counts[folder.role] || ''}</span>
            </button>`).join('');
        this.modal.querySelectorAll('[data-folder]').forEach(btn => btn.addEventListener('click', e => {
            this.filters.folder = e.currentTarget.dataset.folder;
            this.activeThreadId = null;
            this._load();
        }));
    }

    _renderThreads() {
        const container = this.modal.querySelector('#email-thread-list');
        if (!this.threads.length) {
            container.innerHTML = '<div class="email-empty">No matching threads.</div>';
            return;
        }
        container.innerHTML = this.threads.map(thread => {
            const latest = thread.latest;
            const triage = latest.triage || {};
            return `<button type="button" class="email-thread ${thread.threadId === this.activeThreadId ? 'active' : ''} ${thread.unread ? 'unread' : ''}" data-thread-id="${escapeHtml(thread.threadId)}">
                <div class="email-thread-top"><strong>${escapeHtml(latest.subject || '(no subject)')}</strong><span>${escapeHtml(fmtDate(latest.date))}</span></div>
                <div class="email-thread-meta">${escapeHtml(addr(latest.from))} · ${thread.count} msg · ${thread.unread} unread</div>
                <p>${escapeHtml(latest.preview || '')}</p>
                <div class="email-badges"><span>${escapeHtml(triage.category || 'inbox')}</span><span>${escapeHtml(triage.priority || 'none')}</span>${latest.followUp?.enabled ? '<span>follow-up</span>' : ''}</div>
            </button>`;
        }).join('');
        container.querySelectorAll('[data-thread-id]').forEach(btn => btn.addEventListener('click', e => {
            this.activeThreadId = e.currentTarget.dataset.threadId;
            this._load();
        }));
    }

    _renderReader() {
        const reader = this.modal.querySelector('#email-reader');
        if (!this.activeMessage) {
            reader.innerHTML = '<div class="email-empty">Select a thread to triage.</div>';
            return;
        }
        const message = this.activeMessage;
        const triage = message.triage || {};
        reader.innerHTML = `
            <div class="email-reader-head">
                <div><h3>${escapeHtml(message.subject || '(no subject)')}</h3><p>${escapeHtml(addr(message.from))} → ${(message.to || []).map(addr).map(escapeHtml).join(', ')}</p><p>${escapeHtml(fmtDate(message.date))}</p></div>
                <div class="email-reader-actions">
                    <button data-action="triage" type="button">Run triage</button>
                    <button data-action="reply" type="button">Draft reply</button>
                    <button data-action="archive" type="button">Archive</button>
                    <button data-action="followup" type="button">Follow up</button>
                </div>
            </div>
            <article class="email-message-body">${escapeHtml(message.body || message.preview || '').replace(/\n/g, '<br>')}</article>
            <section class="email-triage">
                <h4>AI triage</h4>
                <div class="email-badges"><span>${escapeHtml(triage.category || 'inbox')}</span><span>${escapeHtml(triage.priority || 'none')}</span><span>${Math.round((triage.confidence || 0) * 100)}% confidence</span></div>
                <p>${escapeHtml(triage.summary || 'No summary yet.')}</p>
                <ul>${(triage.actionItems || []).map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>No action items detected.</li>'}</ul>
                <textarea id="email-suggested-reply" placeholder="Suggested draft reply">${escapeHtml(triage.suggestedReply || '')}</textarea>
                <div class="email-proposals">
                    <button data-propose="task" type="button">Email → task</button>
                    <button data-propose="note" type="button">Email → note</button>
                    <button data-propose="calendar" type="button">Email → calendar</button>
                </div>
            </section>
            <section class="email-provenance"><strong>Provenance</strong>${(message.provenance || []).slice(-6).map(p => `<p>${escapeHtml(fmtDate(p.at))}: ${escapeHtml(p.action)} ${escapeHtml(p.detail || '')}</p>`).join('') || '<p>Seed/import provenance only.</p>'}</section>`;
        reader.querySelector('[data-action="triage"]').addEventListener('click', () => this._triageMessage(message.id));
        reader.querySelector('[data-action="reply"]').addEventListener('click', () => this._reply(message));
        reader.querySelector('[data-action="archive"]').addEventListener('click', () => this._archive(message.id));
        reader.querySelector('[data-action="followup"]').addEventListener('click', () => this._setFollowup(message.id));
        reader.querySelectorAll('[data-propose]').forEach(btn => btn.addEventListener('click', e => this._propose(message.id, e.currentTarget.dataset.propose)));
    }

    _renderDrafts() {
        const container = this.modal.querySelector('#email-draft-list');
        if (!this.drafts.length) {
            container.innerHTML = '<p class="email-muted">No drafts yet.</p>';
            return;
        }
        container.innerHTML = this.drafts.map(draft => `<div class="email-draft">
            <strong>${escapeHtml(draft.subject || '(no subject)')}</strong>
            <span>${escapeHtml(draft.draft?.status || 'composing')}</span>
            <textarea data-draft-body="${escapeHtml(draft.id)}">${escapeHtml(draft.body || '')}</textarea>
            <div><button data-request="${escapeHtml(draft.id)}" type="button">Request review</button><button data-approve="${escapeHtml(draft.id)}" type="button">Approve & send</button><button data-reject="${escapeHtml(draft.id)}" type="button">Reject</button></div>
        </div>`).join('');
        container.querySelectorAll('[data-draft-body]').forEach(input => input.addEventListener('change', e => emailService.updateDraft(e.currentTarget.dataset.draftBody, { body: e.currentTarget.value })));
        container.querySelectorAll('[data-request]').forEach(btn => btn.addEventListener('click', e => this._requestApproval(e.currentTarget.dataset.request)));
        container.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', e => this._approveDraft(e.currentTarget.dataset.approve)));
        container.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', e => this._rejectDraft(e.currentTarget.dataset.reject)));
    }

    async _saveAccount() {
        const account = this.accounts[0] || {};
        await emailService.saveAccount({
            id: account.id,
            name: this.modal.querySelector('#email-account-name').value,
            address: this.modal.querySelector('#email-account-address').value,
            provider: this.modal.querySelector('#email-account-provider').value,
            imap: { host: this.modal.querySelector('#email-imap-host').value, port: Number(this.modal.querySelector('#email-imap-port').value) || null },
            smtp: { host: this.modal.querySelector('#email-smtp-host').value, port: Number(this.modal.querySelector('#email-smtp-port').value) || null },
            routing: { signature: this.modal.querySelector('#email-signature').value }
        });
        toast.success('Email account settings saved locally');
        await this._load();
    }

    async _validateAccount() {
        const account = this.accounts[0];
        if (!account) return;
        const result = await emailService.validateCredentials(account.id, { username: account.address });
        toast.info(result.message);
        await this._load();
    }

    async _triageVisible() {
        const ids = this.threads.map(thread => thread.latest.id);
        await emailService.triageBatch(ids);
        toast.success(`Triaged ${ids.length} visible threads`);
        await this._load();
    }

    async _triageMessage(id) {
        await emailService.triageMessage(id);
        toast.success('Thread triaged');
        await this._load();
    }

    async _reply(message) {
        const suggested = this.modal.querySelector('#email-suggested-reply')?.value || message.triage?.suggestedReply || '';
        const draft = await emailService.composeDraft({ inReplyTo: message.id, body: `${suggested}\n\n${this.accounts[0]?.routing?.signature || ''}`.trim() });
        toast.info('Draft created. Review and approve before sending.');
        await this._load();
        this.activeThreadId = draft.threadId;
    }

    async _compose(input = {}) {
        await emailService.composeDraft(input);
        toast.info('Draft created. It cannot send until approved.');
        await this._load();
    }

    async _archive(id) {
        await emailService.archive(id);
        toast.success('Archived');
        this.activeThreadId = null;
        await this._load();
    }

    async _setFollowup(id) {
        const due = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await emailService.setFollowUp(id, { dueAt: due });
        toast.success(`Follow-up set for ${fmtDate(due)}`);
        await this._load();
    }

    async _propose(id, target) {
        await emailService.proposeTarget(id, target, { title: this.activeMessage?.subject });
        toast.success(`Created ${target} proposal with email provenance`);
    }

    async _requestApproval(id) {
        await emailService.requestApproval(id);
        toast.info('Draft moved to approval queue');
        await this._load();
    }

    async _approveDraft(id) {
        const result = await emailService.approveDraft(id);
        toast.success(result.sent ? 'Draft approved and moved to Sent' : 'Approval required');
        await this._load();
    }

    async _rejectDraft(id) {
        await emailService.rejectDraft(id, 'Rejected from email workspace review gate');
        toast.warning('Draft rejected');
        await this._load();
    }
}

export function createEmailPanel() {
    return new EmailPanel();
}

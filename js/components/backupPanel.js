/** BackupPanel — UI for local backups, restore preview, and self-host operations. */
import { backupService } from '../services/backupService.js';
import { toast } from './toast.js';

function statusClass(status) {
    return `ops-status ${status || 'unknown'}`;
}

function countList(counts = {}) {
    const entries = Object.entries(counts);
    if (!entries.length) return '<p class="ops-muted">No store counts available.</p>';
    return `<div class="ops-store-grid">${entries.map(([store, count]) => `
        <span>${store}</span><strong>${typeof count === 'number' ? count : 'error'}</strong>
    `).join('')}</div>`;
}

class BackupPanel {
    constructor() {
        this.opened = false;
        this.preview = null;
        this.health = null;
        this.render();
        this.attachEvents();
    }

    isOpen() { return this.opened; }

    open() {
        this.opened = true;
        document.getElementById('backup-modal')?.classList.remove('hidden');
        this.refresh();
        refreshIcons();
    }

    close() {
        this.opened = false;
        document.getElementById('backup-modal')?.classList.add('hidden');
    }

    render() {
        const modal = document.createElement('div');
        modal.id = 'backup-modal';
        modal.className = 'backup-modal hidden';
        modal.innerHTML = `
            <div class="backup-overlay"></div>
            <section class="backup-panel" role="dialog" aria-modal="true" aria-labelledby="backup-title">
                <header class="backup-header">
                    <div>
                        <h2 id="backup-title"><i data-lucide="server-cog" class="icon"></i> Backup, Restore & Ops</h2>
                        <p>Export a complete local workspace backup, preview restores before applying, and check self-host readiness.</p>
                    </div>
                    <button id="backup-close-btn" class="backup-icon-btn" type="button" aria-label="Close"><i data-lucide="x" class="icon"></i></button>
                </header>
                <div class="backup-body">
                    <section class="ops-card ops-actions">
                        <h3>Manual Backup</h3>
                        <p class="ops-muted">Creates a JSON backup of all Synapse IndexedDB stores plus selected local UI settings.</p>
                        <div class="ops-row">
                            <button id="create-backup-btn" class="ops-primary" type="button"><i data-lucide="download" class="icon"></i> Create Backup</button>
                            <label class="ops-file-label"><i data-lucide="upload" class="icon"></i> Choose Restore File<input id="restore-file-input" type="file" accept="application/json,.json"></label>
                        </div>
                    </section>

                    <section class="ops-card">
                        <h3>Backup Coverage</h3>
                        <div id="backup-coverage" class="ops-coverage"></div>
                    </section>

                    <section class="ops-card">
                        <h3>Restore Preview</h3>
                        <div id="restore-preview" class="ops-preview"><p class="ops-muted">Choose a backup file to validate it before restore. Nothing is applied during preview.</p></div>
                        <div class="ops-row">
                            <label class="ops-check"><input id="restore-localstorage-toggle" type="checkbox" checked> Restore local UI settings</label>
                            <label class="ops-check"><input id="restore-overwrite-toggle" type="checkbox" checked> Replace selected stores</label>
                            <button id="apply-restore-btn" class="ops-danger" type="button" disabled><i data-lucide="rotate-ccw" class="icon"></i> Apply Restore</button>
                        </div>
                    </section>

                    <section class="ops-card">
                        <div class="ops-section-heading">
                            <h3>Instance Health</h3>
                            <button id="refresh-health-btn" class="ops-secondary" type="button"><i data-lucide="refresh-cw" class="icon"></i> Refresh</button>
                        </div>
                        <div id="ops-health" class="ops-health"><p class="ops-muted">Loading health report…</p></div>
                    </section>

                    <section class="ops-card">
                        <h3>Self-Hosted Operations Guide</h3>
                        <div id="ops-guide" class="ops-guide"></div>
                    </section>
                </div>
            </section>`;
        document.body.appendChild(modal);
        this.renderCoverage();
        this.renderGuide();
    }

    attachEvents() {
        document.getElementById('backup-close-btn')?.addEventListener('click', () => this.close());
        document.querySelector('#backup-modal .backup-overlay')?.addEventListener('click', () => this.close());
        document.getElementById('create-backup-btn')?.addEventListener('click', () => this.createBackup());
        document.getElementById('restore-file-input')?.addEventListener('change', (event) => this.previewFile(event.target.files?.[0]));
        document.getElementById('apply-restore-btn')?.addEventListener('click', () => this.applyRestore());
        document.getElementById('refresh-health-btn')?.addEventListener('click', () => this.refreshHealth());
    }

    async refresh() {
        await this.refreshHealth();
    }

    renderCoverage() {
        const target = document.getElementById('backup-coverage');
        if (!target) return;
        target.innerHTML = backupService.getCoverage().map(group => `
            <article class="ops-coverage-group">
                <h4>${group.label}</h4>
                <p>${group.note}</p>
                <div>${group.stores.map(store => `<span class="ops-pill ${store.available ? '' : 'missing'}">${store.name}</span>`).join('')}${(group.localStorage || []).map(key => `<span class="ops-pill local">${key}</span>`).join('')}</div>
            </article>
        `).join('');
    }

    renderGuide() {
        const guide = backupService.getOperationsGuide();
        const target = document.getElementById('ops-guide');
        if (!target) return;
        target.innerHTML = Object.entries(guide).map(([title, items]) => `
            <details open>
                <summary>${title.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</summary>
                <ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>
            </details>
        `).join('');
    }

    async createBackup() {
        try {
            const backup = await backupService.createBackup();
            backupService.downloadBackup(backup);
            toast.success('Synapse backup created. Store it somewhere safe/encrypted.');
        } catch (error) {
            console.error(error);
            toast.error(`Backup failed: ${error.message}`);
        }
    }

    async previewFile(file) {
        if (!file) return;
        try {
            this.preview = await backupService.previewBackupFile(file);
            this.renderPreview();
        } catch (error) {
            this.preview = { valid: false, errors: [error.message], warnings: [], stores: [], counts: {} };
            this.renderPreview();
        }
    }

    renderPreview() {
        const target = document.getElementById('restore-preview');
        const apply = document.getElementById('apply-restore-btn');
        if (!target || !this.preview) return;
        apply.disabled = !this.preview.valid;
        target.innerHTML = `
            <div class="ops-preview-summary">
                <span class="${statusClass(this.preview.valid ? 'ok' : 'critical')}">${this.preview.valid ? 'Valid' : 'Blocked'}</span>
                <span>Created: ${this.preview.createdAt || 'unknown'}</span>
                <span>DB version: ${this.preview.dbVersion || 'unknown'}</span>
            </div>
            ${this.preview.errors.length ? `<div class="ops-alert critical"><strong>Errors</strong><ul>${this.preview.errors.map(e => `<li>${e}</li>`).join('')}</ul></div>` : ''}
            ${this.preview.warnings.length ? `<div class="ops-alert warning"><strong>Warnings</strong><ul>${this.preview.warnings.map(w => `<li>${w}</li>`).join('')}</ul></div>` : ''}
            <h4>Stores to restore</h4>${countList(this.preview.counts)}
            <p class="ops-muted">LocalStorage keys: ${this.preview.localStorageKeys?.join(', ') || 'none'}</p>`;
    }

    async applyRestore() {
        if (!this.preview?.valid) return;
        if (!confirm('Apply this restore now? Selected stores may be replaced.')) return;
        try {
            const result = await backupService.applyRestore(this.preview, {
                overwrite: document.getElementById('restore-overwrite-toggle')?.checked !== false,
                restoreLocalStorage: document.getElementById('restore-localstorage-toggle')?.checked !== false
            });
            toast.success(`Restore applied (${Object.keys(result.restored).length} stores). Reload Synapse to refresh all panels.`);
            await this.refreshHealth();
        } catch (error) {
            console.error(error);
            toast.error(`Restore failed: ${error.message}`);
        }
    }

    async refreshHealth() {
        const target = document.getElementById('ops-health');
        if (!target) return;
        target.innerHTML = '<p class="ops-muted">Checking instance health…</p>';
        try {
            this.health = await backupService.getHealthReport();
            target.innerHTML = `
                <div class="ops-health-checks">${this.health.checks.map(check => `
                    <article class="ops-health-check">
                        <span class="${statusClass(check.status)}">${check.status}</span>
                        <strong>${check.label}</strong>
                        <p>${check.detail}</p>
                    </article>
                `).join('')}</div>
                <h4>Store counts</h4>${countList(this.health.counts)}`;
        } catch (error) {
            target.innerHTML = `<div class="ops-alert critical">Health check failed: ${error.message}</div>`;
        }
    }
}

export function createBackupPanel() {
    return new BackupPanel();
}

export default BackupPanel;

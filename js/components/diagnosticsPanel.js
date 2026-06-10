/**
 * DiagnosticsPanel — Modal panel displaying system health, degraded states,
 * error logs, and recovery suggestions.
 *
 * Usage:
 *   const panel = createDiagnosticsPanel();
 *   panel.open();   // show
 *   panel.close();  // hide
 */

import { diagnosticsService, HealthStatus, Domains } from '../services/diagnosticsService.js';

let _instance = null;

// ── Status styling ────────────────────────────────────────────────────────

const STATUS_STYLES = {
    [HealthStatus.HEALTHY]:  { cls: 'diag-status-healthy',  label: 'Healthy',   icon: 'check-circle' },
    [HealthStatus.DEGRADED]: { cls: 'diag-status-degraded', label: 'Degraded',  icon: 'alert-triangle' },
    [HealthStatus.OFFLINE]:  { cls: 'diag-status-offline',  label: 'Offline',   icon: 'x-circle' },
    [HealthStatus.UNKNOWN]:  { cls: 'diag-status-unknown',  label: 'Not configured', icon: 'help-circle' },
};

// ── Factory ───────────────────────────────────────────────────────────────

export function createDiagnosticsPanel() {
    if (_instance) return _instance;
    _instance = new DiagnosticsPanel();
    return _instance;
}

class DiagnosticsPanel {
    constructor() {
        /** @type {HTMLElement|null} */
        this._overlay = null;
        /** @type {HTMLElement|null} */
        this._panel = null;
        /** @type {boolean} */
        this._open = false;
        /** @type {boolean} */
        this._loading = false;

        this._buildDOM();
    }

    // ─── Public API ────────────────────────────────────────────────────────

    open() {
        if (this._open) return;
        this._open = true;
        this._overlay.classList.add('diag-overlay-active');
        this._panel.classList.add('diag-panel-active');
        this._runChecks();
    }

    close() {
        if (!this._open) return;
        this._open = false;
        this._overlay.classList.remove('diag-overlay-active');
        this._panel.classList.remove('diag-panel-active');
    }

    isOpen() {
        return this._open;
    }

    // ─── DOM construction ──────────────────────────────────────────────────

    /** @private */
    _buildDOM() {
        // Overlay backdrop
        this._overlay = document.createElement('div');
        this._overlay.className = 'diag-overlay';
        this._overlay.addEventListener('click', () => this.close());

        // Panel
        this._panel = document.createElement('div');
        this._panel.className = 'diag-panel';
        this._panel.setAttribute('role', 'dialog');
        this._panel.setAttribute('aria-label', 'System Diagnostics');

        this._panel.innerHTML = `
            <div class="diag-header">
                <div class="diag-header-left">
                    <i data-lucide="activity" class="icon"></i>
                    <h2>Diagnostics</h2>
                </div>
                <div class="diag-header-right">
                    <button class="diag-btn diag-btn-ghost" id="diag-refresh-btn" title="Refresh checks">
                        <i data-lucide="refresh-cw" class="icon"></i>
                    </button>
                    <button class="diag-btn diag-btn-ghost diag-close-btn" title="Close">
                        <i data-lucide="x" class="icon"></i>
                    </button>
                </div>
            </div>
            <div class="diag-overall" id="diag-overall"></div>
            <div class="diag-body" id="diag-body">
                <div class="diag-loading">Running health checks…</div>
            </div>
            <div class="diag-footer">
                <div class="diag-log-toggle">
                    <button class="diag-btn diag-btn-ghost" id="diag-log-toggle-btn">
                        <i data-lucide="file-text" class="icon"></i>
                        <span>Error Log</span>
                    </button>
                </div>
            </div>
            <div class="diag-log-panel" id="diag-log-panel" style="display:none;">
                <div class="diag-log-header">
                    <h3>Error Log</h3>
                    <button class="diag-btn diag-btn-ghost" id="diag-log-close-btn">
                        <i data-lucide="chevron-down" class="icon"></i>
                    </button>
                </div>
                <div class="diag-log-body" id="diag-log-body">
                    <p class="diag-empty">No errors recorded.</p>
                </div>
            </div>
        `;

        document.body.appendChild(this._overlay);
        document.body.appendChild(this._panel);

        // Event bindings
        this._panel.querySelector('.diag-close-btn').addEventListener('click', () => this.close());
        this._panel.querySelector('#diag-refresh-btn').addEventListener('click', () => this._runChecks());
        this._panel.querySelector('#diag-log-toggle-btn').addEventListener('click', () => this._toggleLog());
        this._panel.querySelector('#diag-log-close-btn').addEventListener('click', () => this._toggleLog(false));

        // Initialize Lucide icons inside panel
        if (typeof lucide !== 'undefined') {
            lucide.createIcons({ el: this._panel });
        }
    }

    // ─── Health checks ─────────────────────────────────────────────────────

    /** @private */
    async _runChecks() {
        const refreshBtn = this._panel.querySelector('#diag-refresh-btn');
        refreshBtn?.classList.add('diag-spin');

        this._loading = true;
        const body = this._panel.querySelector('#diag-body');
        body.innerHTML = '<div class="diag-loading"><span class="diag-spinner"></span> Running health checks…</div>';

        try {
            const snapshot = await diagnosticsService.runAllChecks();
            this._render(snapshot);
        } catch (e) {
            body.innerHTML = `<div class="diag-error">Failed to run diagnostics: ${_esc(e.message)}</div>`;
        } finally {
            this._loading = false;
            refreshBtn?.classList.remove('diag-spin');
        }
    }

    // ─── Rendering ─────────────────────────────────────────────────────────

    /** @private */
    _render(snapshot) {
        // Overall status banner
        const overall = this._panel.querySelector('#diag-overall');
        const os = STATUS_STYLES[snapshot.overallStatus] || STATUS_STYLES[HealthStatus.UNKNOWN];
        overall.className = `diag-overall diag-overall-${snapshot.overallStatus}`;
        overall.innerHTML = `
            <i data-lucide="${os.icon}" class="icon"></i>
            <span>System Status: <strong>${os.label}</strong></span>
        `;

        // Domain cards
        const body = this._panel.querySelector('#diag-body');
        body.innerHTML = '';

        for (const key of Object.values(Domains)) {
            const domain = snapshot.domains[key];
            if (!domain) continue;
            body.appendChild(this._renderDomainCard(domain));
        }

        // Error log
        const logBody = this._panel.querySelector('#diag-log-body');
        if (snapshot.errorLog.length === 0) {
            logBody.innerHTML = '<p class="diag-empty">No errors recorded.</p>';
        } else {
            logBody.innerHTML = snapshot.errorLog.slice().reverse().map(e => `
                <div class="diag-log-entry">
                    <span class="diag-log-ts">${_fmtTime(e.ts)}</span>
                    <span class="diag-log-domain">[${_esc(e.domain)}]</span>
                    <span class="diag-log-msg">${_esc(e.message)}</span>
                </div>
            `).join('');
        }

        // Refresh Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons({ el: this._panel });
        }
    }

    /** @private */
    _renderDomainCard(domain) {
        const card = document.createElement('div');
        card.className = `diag-domain-card diag-domain-${domain.status}`;

        const ds = STATUS_STYLES[domain.status] || STATUS_STYLES[HealthStatus.UNKNOWN];
        const lastCheck = domain.lastCheck ? _fmtTime(domain.lastCheck) : 'Not checked';
        const docsLink = diagnosticsService.getDocsLink(domain.key);

        let checksHTML = domain.checks.map(c => {
            const cs = STATUS_STYLES[c.status] || STATUS_STYLES[HealthStatus.UNKNOWN];
            let recoveryHTML = '';
            if (c.recoveryKey) {
                const recovery = diagnosticsService.getRecovery(c.recoveryKey);
                recoveryHTML = `<div class="diag-check-recovery"><i data-lucide="lightbulb" class="icon"></i> ${_esc(recovery)}</div>`;
            }
            return `
                <div class="diag-check">
                    <div class="diag-check-header">
                        <span class="diag-check-status ${cs.cls}"><i data-lucide="${cs.icon}" class="icon"></i></span>
                        <span class="diag-check-name">${_esc(c.name)}</span>
                        <span class="diag-check-label ${cs.cls}">${cs.label}</span>
                    </div>
                    <div class="diag-check-detail">${_esc(c.detail)}</div>
                    ${recoveryHTML}
                </div>
            `;
        }).join('');

        let docsHTML = '';
        if (docsLink) {
            docsHTML = `<a href="${docsLink}" target="_blank" rel="noopener" class="diag-docs-link"><i data-lucide="external-link" class="icon"></i> Documentation</a>`;
        }

        card.innerHTML = `
            <div class="diag-domain-header">
                <div class="diag-domain-title">
                    <i data-lucide="${domain.icon}" class="icon"></i>
                    <span>${_esc(domain.label)}</span>
                </div>
                <div class="diag-domain-meta">
                    <span class="diag-domain-status ${ds.cls}"><i data-lucide="${ds.icon}" class="icon"></i> ${ds.label}</span>
                </div>
            </div>
            <div class="diag-checks">${checksHTML || '<p class="diag-empty">No checks available.</p>'}</div>
            ${domain.lastError ? `<div class="diag-domain-error"><i data-lucide="alert-circle" class="icon"></i> Last error: ${_esc(domain.lastError)}</div>` : ''}
            <div class="diag-domain-footer">
                <span class="diag-last-check">Last checked: ${lastCheck}</span>
                ${docsHTML}
            </div>
        `;

        return card;
    }

    // ─── Log toggle ────────────────────────────────────────────────────────

    /** @private */
    _toggleLog(forceState) {
        const logPanel = this._panel.querySelector('#diag-log-panel');
        const visible = forceState !== undefined ? forceState : logPanel.style.display === 'none';
        logPanel.style.display = visible ? 'block' : 'none';
    }
}

// ── Utility ───────────────────────────────────────────────────────────────

function _esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function _fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

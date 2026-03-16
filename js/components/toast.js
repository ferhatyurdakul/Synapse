/**
 * Toast - Lightweight notification system
 *
 * Usage:
 *   toast.info('Message')
 *   toast.success('Saved', { duration: 3000 })
 *   toast.warning('Low context')
 *   toast.error('Failed to connect')
 *
 *   // Persistent toast (no auto-dismiss):
 *   const t = toast.info('Loading...', { duration: 0 });
 *   t.dismiss();
 */

const ICONS = {
    info:    'info',
    success: 'check-circle',
    warning: 'alert-triangle',
    error:   'x-circle'
};

const DEFAULT_DURATION = 4000;

class ToastManager {
    constructor() {
        this._container = null;
        this._id = 0;
    }

    _getContainer() {
        if (!this._container) {
            this._container = document.createElement('div');
            this._container.id = 'toast-container';
            this._container.setAttribute('aria-live', 'polite');
            this._container.setAttribute('aria-atomic', 'false');
            document.body.appendChild(this._container);
        }
        return this._container;
    }

    /**
     * Show a toast notification
     * @param {string} message
     * @param {{ type?: 'info'|'success'|'warning'|'error', duration?: number }} options
     * @returns {{ id: number, dismiss: Function }}
     */
    show(message, { type = 'info', duration = DEFAULT_DURATION } = {}) {
        const container = this._getContainer();
        const id = ++this._id;
        const icon = ICONS[type] ?? ICONS.info;

        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.setAttribute('role', 'alert');
        el.dataset.toastId = id;

        el.innerHTML = `
            <i data-lucide="${icon}" class="toast-icon icon"></i>
            <span class="toast-message">${message}</span>
            <button class="toast-close" aria-label="Dismiss notification">
                <i data-lucide="x" class="icon"></i>
            </button>
        `;

        container.appendChild(el);
        if (typeof lucide !== 'undefined') lucide.createIcons({ el });

        // Trigger enter animation on next frame
        requestAnimationFrame(() => el.classList.add('toast-visible'));

        const dismiss = () => {
            if (!el.isConnected) return;
            el.classList.remove('toast-visible');
            el.classList.add('toast-leaving');
            el.addEventListener('transitionend', () => el.remove(), { once: true });
            if (timer) clearTimeout(timer);
        };

        el.querySelector('.toast-close').addEventListener('click', dismiss);

        const timer = duration > 0 ? setTimeout(dismiss, duration) : null;

        return { id, dismiss };
    }

    info(message, options = {})    { return this.show(message, { type: 'info',    ...options }); }
    success(message, options = {}) { return this.show(message, { type: 'success', ...options }); }
    warning(message, options = {}) { return this.show(message, { type: 'warning', ...options }); }
    error(message, options = {})   { return this.show(message, { type: 'error',   ...options }); }
}

export const toast = new ToastManager();

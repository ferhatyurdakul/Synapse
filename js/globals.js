/**
 * Global utility functions used by inline onclick handlers in dynamically rendered HTML.
 * Extracted from index.html to allow a tighter Content-Security-Policy.
 */

// Copy code block content
window.copyCodeBlock = async function (btn) {
    const container = btn.closest('.code-block-container');
    const encodedCode = container.dataset.code;
    const code = decodeURIComponent(atob(encodedCode));

    try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML = '<i data-lucide="check" class="icon"></i> Copied!';
        btn.classList.add('success');
        refreshIcons();
        setTimeout(() => {
            btn.innerHTML = '<i data-lucide="copy" class="icon"></i> Copy';
            btn.classList.remove('success');
            refreshIcons();
        }, 2000);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
};

// Copy message content
window.copyMessageContent = async function (btn) {
    const message = btn.closest('.message');
    const content = message.querySelector('.message-content');
    const text = content.innerText || content.textContent;

    try {
        await navigator.clipboard.writeText(text);
        btn.innerHTML = '<i data-lucide="check" class="icon"></i>';
        btn.classList.add('success');
        refreshIcons();
        setTimeout(() => {
            btn.innerHTML = '<i data-lucide="copy" class="icon"></i>';
            btn.classList.remove('success');
            refreshIcons();
        }, 2000);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
};

// Resend last user message
window.resendMessage = function (btn) {
    const message = btn.closest('.message');
    const content = message.querySelector('.message-content');
    const text = content.innerText || content.textContent;
    window.dispatchEvent(new CustomEvent('resend-message', { detail: { content: text } }));
};

// Edit user message
window.editMessage = function (index) {
    window.dispatchEvent(new CustomEvent('edit-message', { detail: { index } }));
};

// Save edited message
window.saveEditMessage = function (index) {
    window.dispatchEvent(new CustomEvent('save-edit-message', { detail: { index } }));
};

// Cancel edit
window.cancelEditMessage = function (index) {
    window.dispatchEvent(new CustomEvent('cancel-edit-message', { detail: { index } }));
};

// Regenerate from here
window.regenerateFromHere = function (index) {
    window.dispatchEvent(new CustomEvent('regenerate-from-here', { detail: { index } }));
};

// Branch from here
window.branchFromHere = function (index) {
    window.dispatchEvent(new CustomEvent('branch-from-here', { detail: { index } }));
};

// ── Throttled Lucide icon refresh ──
// Deduplicates rapid createIcons() calls using microtask batching
window.refreshIcons = (function () {
    let pending = false;
    return function () {
        if (typeof lucide === 'undefined' || pending) return;
        pending = true;
        queueMicrotask(() => {
            lucide.createIcons();
            pending = false;
        });
    };
})();

// ── Image Lightbox ──
(function () {
    let overlay = null;
    let img = null;
    let scale = 1;

    function open(src) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'lightbox-overlay';
            overlay.innerHTML = `
                <button class="lightbox-close" aria-label="Close">&times;</button>
                <img class="lightbox-img" src="" alt="Enlarged image">
            `;
            document.body.appendChild(overlay);
            img = overlay.querySelector('.lightbox-img');

            overlay.addEventListener('click', (e) => {
                if (e.target === img) return;
                close();
            });
            overlay.querySelector('.lightbox-close').addEventListener('click', close);
            overlay.addEventListener('wheel', (e) => {
                e.preventDefault();
                scale += e.deltaY < 0 ? 0.2 : -0.2;
                scale = Math.max(0.2, Math.min(scale, 5));
                img.style.transform = `scale(${scale})`;
            }, { passive: false });
        }

        scale = 1;
        img.style.transform = 'scale(1)';
        img.src = src;
        overlay.classList.add('active');
    }

    function close() {
        if (overlay) overlay.classList.remove('active');
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay?.classList.contains('active')) {
            close();
        }
    });

    document.addEventListener('click', (e) => {
        const thumb = e.target.closest('.message-image-thumb, .image-preview-item img');
        if (thumb) open(thumb.src);
    });
})();

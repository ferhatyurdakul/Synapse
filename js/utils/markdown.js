/**
 * Markdown - Enhanced markdown to HTML converter with LaTeX support
 * Uses marked.js for markdown, KaTeX for LaTeX math, and highlight.js for syntax highlighting
 */

// Wait for KaTeX to be ready
let katexReady = false;
let katexReadyCallbacks = [];

// Check if KaTeX is loaded
function checkKatexReady() {
    if (typeof katex !== 'undefined' && typeof renderMathInElement !== 'undefined') {
        katexReady = true;
        katexReadyCallbacks.forEach(cb => cb());
        katexReadyCallbacks = [];
        return true;
    }
    return false;
}

// Poll for KaTeX
const katexInterval = setInterval(() => {
    if (checkKatexReady()) {
        clearInterval(katexInterval);
    }
}, 100);

/**
 * Get the line numbers setting from storage (sync read).
 * Defaults to false if storage not yet available.
 */
function _lineNumbersEnabled() {
    try {
        // storageService is a module singleton; access via dynamic import is too heavy,
        // so we read directly from the global cache that storageService maintains.
        if (window._synapseSettingsCache) return !!window._synapseSettingsCache.codeBlockLineNumbers;
    } catch { /* ignore */ }
    return false;
}

/**
 * Configure marked.js with custom renderer
 */
function getMarkedInstance() {
    if (typeof marked === 'undefined') {
        console.warn('marked.js not loaded, using fallback renderer');
        return null;
    }

    // Create custom renderer for code blocks
    const renderer = new marked.Renderer();

    // Handle both old API (code, language) and new API ({text, lang})
    renderer.code = function (codeOrObj, language) {
        let code, lang;
        if (typeof codeOrObj === 'object' && codeOrObj !== null) {
            // New API: marked passes an object {text, lang, escaped}
            code = codeOrObj.text || '';
            lang = codeOrObj.lang || 'plaintext';
        } else {
            // Old API: (code, language)
            code = codeOrObj || '';
            lang = language || 'plaintext';
        }

        // Normalize language name for highlight.js
        lang = lang.trim().toLowerCase() || 'plaintext';

        const escapedCode = escapeHtmlForCode(code);
        let encodedCode;
        try {
            encodedCode = btoa(encodeURIComponent(code));
        } catch (e) {
            encodedCode = '';
        }

        // Display label (original casing, friendly names)
        const displayLang = _friendlyLangName(lang);

        return `<div class="code-block-container" data-code="${encodedCode}">
            <div class="code-block-header">
                <span class="code-block-lang">${displayLang}</span>
                <button class="code-copy-btn" onclick="copyCodeBlock(this)" title="Copy code"><i data-lucide="copy" class="icon"></i> Copy</button>
            </div>
            <pre><code class="language-${lang}">${escapedCode}</code></pre>
        </div>`;
    };

    // Configure marked options
    marked.setOptions({
        gfm: true,
        breaks: true,
        headerIds: false,
        mangle: false,
        renderer: renderer
    });

    return marked;
}

/**
 * Map technical language identifiers to friendly display names
 */
function _friendlyLangName(lang) {
    const names = {
        'js': 'JavaScript',
        'javascript': 'JavaScript',
        'ts': 'TypeScript',
        'typescript': 'TypeScript',
        'py': 'Python',
        'python': 'Python',
        'rb': 'Ruby',
        'ruby': 'Ruby',
        'sh': 'Shell',
        'bash': 'Bash',
        'zsh': 'Zsh',
        'json': 'JSON',
        'html': 'HTML',
        'xml': 'XML',
        'svg': 'SVG',
        'css': 'CSS',
        'scss': 'SCSS',
        'yaml': 'YAML',
        'yml': 'YAML',
        'toml': 'TOML',
        'md': 'Markdown',
        'markdown': 'Markdown',
        'sql': 'SQL',
        'go': 'Go',
        'rust': 'Rust',
        'java': 'Java',
        'cpp': 'C++',
        'c': 'C',
        'cs': 'C#',
        'csharp': 'C#',
        'php': 'PHP',
        'swift': 'Swift',
        'kotlin': 'Kotlin',
        'dart': 'Dart',
        'lua': 'Lua',
        'r': 'R',
        'perl': 'Perl',
        'dockerfile': 'Dockerfile',
        'makefile': 'Makefile',
        'plaintext': 'Text',
        'text': 'Text',
        '': 'Code'
    };
    return names[lang] || lang.toUpperCase();
}

/**
 * Escape HTML for code blocks (preserve structure)
 */
function escapeHtmlForCode(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, char => map[char]);
}

/**
 * Render LaTeX math expressions in an element
 * @param {HTMLElement} element - Element to render LaTeX in
 */
function renderLatexInEl(element) {
    if (!katexReady) return;

    try {
        renderMathInElement(element, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\[', right: '\\]', display: true },
                { left: '\\(', right: '\\)', display: false },
                { left: '[', right: ']', display: true }
            ],
            throwOnError: false,
            errorColor: '#ff4757',
            trust: true
        });
    } catch (error) {
        console.warn('LaTeX rendering error:', error);
    }
}

/**
 * Convert markdown text to HTML
 * @param {string} text - Markdown text
 * @returns {string} HTML string
 */
export function renderMarkdown(text) {
    if (!text) return '';

    // Protect LaTeX expressions from markdown processing
    const latexPlaceholders = [];
    let protectedText = text;

    // Protect display math ($$...$$) - handle multiline  
    protectedText = protectedText.replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
        const placeholder = `%%LATEX_DISPLAY_${latexPlaceholders.length}%%`;
        latexPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    // Protect inline math ($...$) - single line only
    protectedText = protectedText.replace(/\$([^\$\n]+?)\$/g, (match, content) => {
        const placeholder = `%%LATEX_INLINE_${latexPlaceholders.length}%%`;
        latexPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    const markedInstance = getMarkedInstance();

    let html;
    if (markedInstance) {
        html = markedInstance.parse(protectedText);
    } else {
        html = fallbackRenderMarkdown(protectedText);
    }

    // Sanitize before restoring LaTeX (LaTeX is our own content, not from the model)
    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }

    // Restore LaTeX expressions
    latexPlaceholders.forEach(({ placeholder, original }) => {
        html = html.replace(placeholder, original);
    });

    return html;
}

/**
 * Fallback markdown renderer
 */
function fallbackRenderMarkdown(text) {
    let html = escapeHtml(text);

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang || 'plaintext'}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Lists
    html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Blockquotes
    html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');

    if (!html.startsWith('<')) {
        html = `<p>${html}</p>`;
    }

    return html;
}

export function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, char => map[char]);
}

/**
 * Parse thinking blocks from text
 */
export function parseThinkingBlocks(text) {
    const thinkingRegex = /<think>([\s\S]*?)<\/think>/g;
    let thinking = '';
    let content = text;

    let match;
    while ((match = thinkingRegex.exec(text)) !== null) {
        thinking += match[1].trim() + '\n';
    }

    content = content.replace(thinkingRegex, '').trim();

    return {
        thinking: thinking.trim(),
        content
    };
}

/**
 * Re-render LaTeX in a specific element
 * @param {HTMLElement} element - Element to render LaTeX in
 */
export function renderLatexInElement(element) {
    if (katexReady) {
        renderLatexInEl(element);
    } else {
        // Queue for when KaTeX is ready
        katexReadyCallbacks.push(() => renderLatexInEl(element));
    }
}

/**
 * Apply syntax highlighting and optional line numbers to all code blocks
 * inside the given element. Call after innerHTML is set and DOM is ready.
 *
 * @param {HTMLElement} containerEl - The parent element containing .code-block-container elements
 * @param {boolean} lineNumbers - Whether to show line numbers
 */
export function highlightCodeBlocks(containerEl, lineNumbers = false) {
    if (!containerEl) return;

    const codeBlocks = containerEl.querySelectorAll('.code-block-container pre code');

    codeBlocks.forEach(codeEl => {
        // Skip if already highlighted
        if (codeEl.dataset.highlighted === 'true') return;

        // Apply highlight.js syntax highlighting
        if (typeof hljs !== 'undefined') {
            try {
                // Detect language from class if present
                const langClass = [...codeEl.classList].find(c => c.startsWith('language-'));
                const lang = langClass ? langClass.replace('language-', '') : undefined;

                if (lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
                    codeEl.classList.add('language-' + lang);
                    hljs.highlightElement(codeEl);
                } else if (!lang || lang === 'plaintext') {
                    // Plaintext — just add the hljs class for consistent styling
                    codeEl.classList.add('hljs');
                } else {
                    // Let highlight.js auto-detect
                    hljs.highlightElement(codeEl);
                }
            } catch (e) {
                // Graceful fallback — just add hljs class
                codeEl.classList.add('hljs');
            }
        } else {
            codeEl.classList.add('hljs');
        }

        codeEl.dataset.highlighted = 'true';

        // Apply line numbers if enabled
        if (lineNumbers) {
            _applyLineNumbers(codeEl);
        }
    });
}

/**
 * Wrap each line of a code block in a span with a line number gutter.
 * Uses a <table> layout so line numbers are aligned and copy doesn't include them.
 *
 * @param {HTMLElement} codeEl - The <code> element inside a <pre>
 */
function _applyLineNumbers(codeEl) {
    if (codeEl.dataset.lineNumbers === 'true') return;

    const pre = codeEl.parentElement;
    if (!pre) return;

    const html = codeEl.innerHTML;
    // Split into lines — handle both \n and trailing newlines
    const lines = html.split('\n');
    // Remove trailing empty line if the code ended with \n
    if (lines.length > 1 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }

    const lineCount = lines.length;
    const padWidth = String(lineCount).length;

    // Build line-numbered structure using CSS table layout
    // Each line is a row with a gutter cell and a code cell
    let numberedHtml = '';
    for (let i = 0; i < lineCount; i++) {
        const num = String(i + 1).padStart(padWidth, ' ');
        numberedHtml += `<span class="code-line" data-line="${i + 1}"><span class="code-line-number">${num}</span><span class="code-line-content">${lines[i] || ' '}</span></span>`;
        if (i < lineCount - 1) {
            numberedHtml += '\n';
        }
    }

    codeEl.innerHTML = numberedHtml;
    pre.classList.add('line-numbers');
    codeEl.dataset.lineNumbers = 'true';
}

/**
 * Remove line numbers from code blocks inside a container.
 * Used when the setting is toggled off to restore plain code.
 *
 * @param {HTMLElement} containerEl - The parent element
 */
export function removeLineNumbers(containerEl) {
    if (!containerEl) return;

    containerEl.querySelectorAll('.code-block-container pre.line-numbers').forEach(pre => {
        const codeEl = pre.querySelector('code');
        if (!codeEl) return;

        // Re-extract plain text from the data-code attribute
        const container = pre.closest('.code-block-container');
        if (container && container.dataset.code) {
            try {
                const plain = decodeURIComponent(atob(container.dataset.code));
                codeEl.innerHTML = escapeHtmlForCode(plain);
                pre.classList.remove('line-numbers');
                delete codeEl.dataset.lineNumbers;

                // Re-apply syntax highlighting
                delete codeEl.dataset.highlighted;
                codeEl.classList.remove('hljs');
                if (typeof hljs !== 'undefined') {
                    try {
                        hljs.highlightElement(codeEl);
                    } catch { /* ignore */ }
                }
                codeEl.dataset.highlighted = 'true';
            } catch { /* ignore */ }
        }
    });
}

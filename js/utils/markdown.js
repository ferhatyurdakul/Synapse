/**
 * Markdown - Enhanced markdown to HTML converter with LaTeX support
 * Uses marked.js for markdown and KaTeX for LaTeX math rendering
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

        const escapedCode = escapeHtmlForCode(code);
        let encodedCode;
        try {
            encodedCode = btoa(encodeURIComponent(code));
        } catch (e) {
            encodedCode = '';
        }

        return `<div class="code-block-container" data-code="${encodedCode}">
            <div class="code-block-header">
                <span class="code-block-lang">${lang}</span>
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

function escapeHtml(text) {
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

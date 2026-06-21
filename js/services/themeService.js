/**
 * ThemeService — Manages UI theme and appearance customization.
 *
 * Themes are applied via data attributes on <html> plus CSS custom properties.
 * Settings are mirrored to localStorage for flash-free page loads.
 */

import { storageService } from './storageService.js';

const LS_KEY = 'synapse_theme';
const LS_APPEARANCE_KEY = 'synapse_appearance';

const DEFAULT_APPEARANCE = {
    theme: 'retro',
    accent: 'cyan',
    typography: 'medium',
    density: 'comfortable',
    codeTheme: 'atom-one-dark',
    sidebar: 'standard',
    layout: 'balanced'
};

const THEMES = [
    { id: 'retro', label: 'Retro Terminal', description: 'Classic neon-on-dark Synapse.' },
    { id: 'modern', label: 'Modern Dark', description: 'Softer panels and calmer contrast.' },
    { id: 'midnight', label: 'Midnight Focus', description: 'Deep blue workspace with violet accents.' },
    { id: 'dawn', label: 'Dawn Light', description: 'Light productive canvas for daytime work.' }
];

const ACCENTS = [
    { id: 'cyan', label: 'Cyan', value: '#00d4ff' },
    { id: 'violet', label: 'Violet', value: '#8b5cf6' },
    { id: 'emerald', label: 'Emerald', value: '#10b981' },
    { id: 'amber', label: 'Amber', value: '#f59e0b' },
    { id: 'rose', label: 'Rose', value: '#f43f5e' }
];

const TYPOGRAPHY = [
    { id: 'compact', label: 'Compact' },
    { id: 'medium', label: 'Medium' },
    { id: 'large', label: 'Large' }
];

const DENSITY = [
    { id: 'compact', label: 'Compact' },
    { id: 'comfortable', label: 'Comfortable' },
    { id: 'spacious', label: 'Spacious' }
];

const CODE_THEMES = [
    { id: 'atom-one-dark', label: 'Atom One Dark', href: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/atom-one-dark.min.css' },
    { id: 'github-dark', label: 'GitHub Dark', href: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github-dark.min.css' },
    { id: 'github', label: 'GitHub Light', href: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/github.min.css' },
    { id: 'tokyo-night-dark', label: 'Tokyo Night', href: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/styles/tokyo-night-dark.min.css' }
];

const SIDEBAR = [
    { id: 'standard', label: 'Standard' },
    { id: 'compact', label: 'Compact' },
    { id: 'wide', label: 'Wide' }
];

const LAYOUT = [
    { id: 'balanced', label: 'Balanced' },
    { id: 'focus', label: 'Focus' },
    { id: 'workspace', label: 'Workspace' }
];

const PRESETS = [
    {
        id: 'synapse-retro',
        label: 'Synapse Retro',
        description: 'Neon terminal energy with dense workspace controls.',
        appearance: { theme: 'retro', accent: 'cyan', typography: 'medium', density: 'comfortable', codeTheme: 'atom-one-dark', sidebar: 'standard', layout: 'balanced' }
    },
    {
        id: 'midnight-research',
        label: 'Midnight Research',
        description: 'Deep blue, violet highlights, and a roomy research layout.',
        appearance: { theme: 'midnight', accent: 'violet', typography: 'medium', density: 'spacious', codeTheme: 'tokyo-night-dark', sidebar: 'wide', layout: 'workspace' }
    },
    {
        id: 'dawn-planning',
        label: 'Dawn Planning',
        description: 'Light mode with emerald accents for task and calendar work.',
        appearance: { theme: 'dawn', accent: 'emerald', typography: 'large', density: 'comfortable', codeTheme: 'github', sidebar: 'standard', layout: 'balanced' }
    },
    {
        id: 'compact-ops',
        label: 'Compact Ops',
        description: 'Tighter density and amber status cues for admin surfaces.',
        appearance: { theme: 'modern', accent: 'amber', typography: 'compact', density: 'compact', codeTheme: 'github-dark', sidebar: 'compact', layout: 'focus' }
    }
];

class ThemeService {
    getTheme() {
        return this.getAppearance().theme;
    }

    setTheme(theme) {
        const appearance = { ...this.getAppearance(), theme };
        this.setAppearance(appearance);
    }

    getAppearance() {
        const settings = storageService.loadSettings();
        return this.normalizeAppearance(settings.appearance || { theme: settings.theme });
    }

    setAppearance(nextAppearance) {
        const appearance = this.normalizeAppearance(nextAppearance);
        this._apply(appearance);

        const settings = storageService.loadSettings();
        settings.theme = appearance.theme;
        settings.appearance = appearance;
        storageService.saveSettings(settings);

        try {
            localStorage.setItem(LS_KEY, appearance.theme);
            localStorage.setItem(LS_APPEARANCE_KEY, JSON.stringify(appearance));
        } catch { /* ignore */ }
    }

    resetAppearance() {
        this.setAppearance(DEFAULT_APPEARANCE);
        return this.getAppearance();
    }

    applyPreset(presetId) {
        const preset = PRESETS.find(item => item.id === presetId);
        if (!preset) return this.getAppearance();
        this.setAppearance(preset.appearance);
        return this.getAppearance();
    }

    /** Apply the saved appearance to the DOM. Call once at startup. */
    applyTheme() {
        this._apply(this.getAppearance());
    }

    getAvailableThemes() { return THEMES; }
    getAccentPalettes() { return ACCENTS; }
    getTypographyScales() { return TYPOGRAPHY; }
    getDensityOptions() { return DENSITY; }
    getCodeThemes() { return CODE_THEMES; }
    getSidebarOptions() { return SIDEBAR; }
    getLayoutOptions() { return LAYOUT; }
    getPresets() { return PRESETS; }
    getDefaultAppearance() { return { ...DEFAULT_APPEARANCE }; }

    normalizeAppearance(appearance = {}) {
        const normalized = { ...DEFAULT_APPEARANCE, ...appearance };
        if (!THEMES.some(item => item.id === normalized.theme)) normalized.theme = DEFAULT_APPEARANCE.theme;
        if (!ACCENTS.some(item => item.id === normalized.accent)) normalized.accent = DEFAULT_APPEARANCE.accent;
        if (!TYPOGRAPHY.some(item => item.id === normalized.typography)) normalized.typography = DEFAULT_APPEARANCE.typography;
        if (!DENSITY.some(item => item.id === normalized.density)) normalized.density = DEFAULT_APPEARANCE.density;
        if (!CODE_THEMES.some(item => item.id === normalized.codeTheme)) normalized.codeTheme = DEFAULT_APPEARANCE.codeTheme;
        if (!SIDEBAR.some(item => item.id === normalized.sidebar)) normalized.sidebar = DEFAULT_APPEARANCE.sidebar;
        if (!LAYOUT.some(item => item.id === normalized.layout)) normalized.layout = DEFAULT_APPEARANCE.layout;
        return normalized;
    }

    /** @private */
    _apply(appearance) {
        const root = document.documentElement;
        if (appearance.theme === 'retro') {
            root.removeAttribute('data-theme');
        } else {
            root.dataset.theme = appearance.theme;
        }
        root.dataset.accent = appearance.accent;
        root.dataset.typography = appearance.typography;
        root.dataset.density = appearance.density;
        root.dataset.sidebar = appearance.sidebar;
        root.dataset.layout = appearance.layout;

        const accent = ACCENTS.find(item => item.id === appearance.accent)?.value;
        if (accent) root.style.setProperty('--appearance-accent', accent);

        const codeTheme = CODE_THEMES.find(item => item.id === appearance.codeTheme);
        const hljsLink = document.getElementById('hljs-theme');
        if (codeTheme?.href && hljsLink) hljsLink.href = codeTheme.href;
    }
}

export const themeService = new ThemeService();

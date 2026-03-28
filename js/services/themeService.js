/**
 * ThemeService — Manages UI theme switching.
 *
 * Themes are applied via the `data-theme` attribute on <html>.
 * The retro theme is the default (no attribute needed).
 * Settings are mirrored to localStorage for flash-free page loads.
 */

import { storageService } from './storageService.js?v=36';

const THEMES = [
    { id: 'retro', label: 'Retro' },
    { id: 'modern', label: 'Modern' }
];

const LS_KEY = 'synapse_theme';

class ThemeService {
    getTheme() {
        return storageService.loadSettings().theme || 'retro';
    }

    setTheme(theme) {
        this._apply(theme);

        // Persist in settings
        const settings = storageService.loadSettings();
        settings.theme = theme;
        storageService.saveSettings(settings);

        // Mirror to localStorage for instant load on refresh
        try { localStorage.setItem(LS_KEY, theme); } catch { /* ignore */ }
    }

    /** Apply the saved theme to the DOM. Call once at startup. */
    applyTheme() {
        const theme = this.getTheme();
        this._apply(theme);
    }

    getAvailableThemes() {
        return THEMES;
    }

    /** @private */
    _apply(theme) {
        if (theme === 'retro') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.dataset.theme = theme;
        }
    }
}

export const themeService = new ThemeService();

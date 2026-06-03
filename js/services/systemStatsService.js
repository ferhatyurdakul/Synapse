import { storageService } from './storageService.js';

function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString() : 'Unavailable';
}

class SystemStatsService {
    formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
        if (bytes === 0) return '0 B';

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const value = bytes / (1024 ** exponent);
        const decimals = value >= 100 || exponent === 0 ? 0 : 1;
        return `${value.toFixed(decimals)} ${units[exponent]}`;
    }

    getLocalStorageUsage() {
        try {
            let bytes = 0;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const value = key ? localStorage.getItem(key) || '' : '';
                bytes += ((key || '').length + value.length) * 2;
            }
            return bytes;
        } catch {
            return null;
        }
    }

    async getStats() {
        const storageInfo = await storageService.getStorageInfo();
        const heap = performance?.memory;

        return {
            app: {
                chatCount: storageInfo.chatCount,
                messageCount: storageInfo.messageCount,
                attachmentCount: storageInfo.attachmentCount
            },
            storage: {
                localStorageBytes: this.getLocalStorageUsage(),
                indexedDbBytes: storageInfo.indexedDbUsed,
                browserUsageBytes: storageInfo.used,
                browserQuotaBytes: storageInfo.quota
            },
            memory: {
                usedJsHeapBytes: Number.isFinite(heap?.usedJSHeapSize) ? heap.usedJSHeapSize : null,
                totalJsHeapBytes: Number.isFinite(heap?.totalJSHeapSize) ? heap.totalJSHeapSize : null,
                jsHeapLimitBytes: Number.isFinite(heap?.jsHeapSizeLimit) ? heap.jsHeapSizeLimit : null
            },
            device: {
                deviceMemory: Number.isFinite(navigator.deviceMemory) ? `${navigator.deviceMemory} GB` : null,
                hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? formatNumber(navigator.hardwareConcurrency) : null
            }
        };
    }
}

export const systemStatsService = new SystemStatsService();

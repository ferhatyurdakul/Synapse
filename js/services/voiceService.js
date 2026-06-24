/**
 * VoiceService — Browser-native speech-to-text and text-to-speech controls.
 *
 * Privacy posture: voice is disabled by default and uses only browser-provided
 * APIs unless a future remote provider is explicitly configured. The Web Speech
 * API may still route audio through the browser vendor depending on browser.
 */

import { storageService } from './storageService.js';
import { chatService } from './chatService.js';
import { eventBus, Events } from '../utils/eventBus.js';

const DEFAULT_VOICE_SETTINGS = {
    enabled: false,
    speechToTextEnabled: false,
    textToSpeechEnabled: false,
    autoSpeakAnswers: false,
    provider: 'browser',
    sttProvider: 'browser',
    ttsProvider: 'browser',
    selectedVoice: '',
    language: 'en-US',
    perMode: {
        chat: true,
        research: false,
        compare: false,
        document: true,
        agent: false
    }
};

class VoiceService {
    constructor() {
        this.recognition = null;
        this.isRecording = false;
        this.isTranscribing = false;
        this.isSpeaking = false;
        this.lastTranscript = '';
    }

    getSettings() {
        const settings = storageService.loadSettings();
        return this.normalizeSettings(settings.voice || {});
    }

    saveSettings(nextVoiceSettings) {
        const settings = storageService.loadSettings();
        settings.voice = this.normalizeSettings(nextVoiceSettings);
        storageService.saveSettings(settings);
        eventBus.emit(Events.VOICE_SETTINGS_CHANGED, { settings: settings.voice });
        this.emitAvailability();
    }

    normalizeSettings(value = {}) {
        return {
            ...DEFAULT_VOICE_SETTINGS,
            ...value,
            perMode: {
                ...DEFAULT_VOICE_SETTINGS.perMode,
                ...(value.perMode || {})
            }
        };
    }

    getAvailability() {
        return {
            stt: typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition),
            tts: typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
            voices: this.getVoices()
        };
    }

    getVoices() {
        if (typeof window === 'undefined' || !window.speechSynthesis) return [];
        return window.speechSynthesis.getVoices().map(voice => ({
            name: voice.name,
            lang: voice.lang,
            localService: voice.localService,
            default: voice.default
        }));
    }

    emitAvailability() {
        eventBus.emit(Events.VOICE_AVAILABILITY_CHANGED, this.getAvailability());
        this.emitState();
    }

    isEnabledForCurrentMode() {
        const settings = this.getSettings();
        const mode = chatService.getCurrentMode?.() || 'chat';
        return settings.enabled === true && settings.perMode?.[mode] !== false;
    }

    canRecord() {
        const settings = this.getSettings();
        return settings.speechToTextEnabled === true && this.isEnabledForCurrentMode() && this.getAvailability().stt;
    }

    canSpeak() {
        const settings = this.getSettings();
        return settings.textToSpeechEnabled === true && this.isEnabledForCurrentMode() && this.getAvailability().tts;
    }

    toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    startRecording() {
        if (!this.canRecord()) {
            this.emitError('Voice input is disabled or unavailable in this browser/mode.');
            return;
        }

        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new Recognition();
        const settings = this.getSettings();
        this.recognition.lang = settings.language || 'en-US';
        this.recognition.continuous = false;
        this.recognition.interimResults = true;
        this.lastTranscript = '';

        this.recognition.onstart = () => {
            this.isRecording = true;
            this.isTranscribing = false;
            this.emitState();
        };

        this.recognition.onresult = (event) => {
            let finalText = '';
            let interimText = '';
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const result = event.results[i];
                const text = result[0]?.transcript || '';
                if (result.isFinal) finalText += text;
                else interimText += text;
            }
            const transcript = (finalText || interimText).trim();
            if (transcript) {
                this.lastTranscript = transcript;
                eventBus.emit(Events.VOICE_TRANSCRIPT_INTERIM, { transcript, final: !!finalText });
            }
            if (finalText.trim()) {
                eventBus.emit(Events.VOICE_TRANSCRIPT_READY, {
                    transcript: finalText.trim(),
                    mode: chatService.getCurrentMode?.() || 'chat',
                    source: 'browser-stt'
                });
            }
        };

        this.recognition.onerror = (event) => {
            this.emitError(event.error ? `Speech recognition error: ${event.error}` : 'Speech recognition failed.');
        };

        this.recognition.onend = () => {
            this.isRecording = false;
            this.isTranscribing = false;
            this.emitState();
        };

        try {
            this.recognition.start();
        } catch (error) {
            this.emitError(error.message || 'Could not start microphone capture.');
        }
    }

    stopRecording() {
        if (!this.recognition) return;
        this.isTranscribing = true;
        this.emitState();
        this.recognition.stop();
    }

    speak(text, options = {}) {
        const content = String(text || '').trim();
        if (!content) return;
        if (!this.canSpeak()) {
            this.emitError('Text-to-speech is disabled or unavailable in this browser/mode.');
            return;
        }
        this.stopSpeaking();
        const settings = this.getSettings();
        const utterance = new SpeechSynthesisUtterance(content);
        utterance.lang = settings.language || 'en-US';
        const selectedVoice = options.voice || settings.selectedVoice;
        if (selectedVoice) {
            const voice = window.speechSynthesis.getVoices().find(v => v.name === selectedVoice);
            if (voice) utterance.voice = voice;
        }
        utterance.onstart = () => {
            this.isSpeaking = true;
            this.emitState();
        };
        utterance.onend = () => {
            this.isSpeaking = false;
            this.emitState();
        };
        utterance.onerror = () => {
            this.isSpeaking = false;
            this.emitError('Speech playback failed.');
            this.emitState();
        };
        window.speechSynthesis.speak(utterance);
    }

    stopSpeaking() {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        if (this.isSpeaking) {
            this.isSpeaking = false;
            this.emitState();
        }
    }

    emitState() {
        eventBus.emit(Events.VOICE_STATE_CHANGED, {
            isRecording: this.isRecording,
            isTranscribing: this.isTranscribing,
            isSpeaking: this.isSpeaking,
            enabledForMode: this.isEnabledForCurrentMode(),
            availability: this.getAvailability()
        });
    }

    emitError(message) {
        eventBus.emit(Events.VOICE_ERROR, { message });
    }
}

export const voiceService = new VoiceService();

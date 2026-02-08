/**
 * TitleService - Generates chat titles using AI models
 */

import { ollamaService } from './ollamaService.js?v=21';
import { storageService } from './storageService.js?v=21';

const TITLE_PROMPT = `### Task:
Generate a concise, 3-5 word title with an emoji summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
- Your entire response must consist solely of the JSON object, without any introductory or concluding text.
- The output must be a single, raw JSON object, without any markdown code fences or other encapsulating text.
- Ensure no conversational text, affirmations, or explanations precede or follow the raw JSON output, as this will cause direct parsing failure.
### Output:
JSON format: { "title": "your concise title here" }
### Examples:
- { "title": "📉 Stock Market Trends" },
- { "title": "🍪 Perfect Chocolate Chip Recipe" },
- { "title": "Evolution of Music Streaming" },
- { "title": "Remote Work Productivity Tips" },
- { "title": "Artificial Intelligence in Healthcare" },
- { "title": "🎮 Video Game Development Insights" }
### Chat History:
<chat_history>
{{MESSAGE}}
</chat_history>`;

class TitleService {
    constructor() {
        this.defaultModel = 'gemma3:1b';
    }

    /**
     * Get the model used for title generation
     * @returns {string}
     */
    getTitleModel() {
        const settings = storageService.loadSettings();
        return settings.titleModel || this.defaultModel;
    }

    /**
     * Set the model used for title generation
     * @param {string} model
     */
    setTitleModel(model) {
        const settings = storageService.loadSettings();
        settings.titleModel = model;
        storageService.saveSettings(settings);
    }

    /**
     * Generate a title for a chat based on the first message
     * @param {string} userMessage - The user's first message
     * @param {string} assistantMessage - The assistant's first response
     * @returns {Promise<string>} Generated title
     */
    async generateTitle(userMessage, assistantMessage = '') {
        const model = this.getTitleModel();

        // Build chat history for the prompt
        let chatHistory = `User: ${userMessage}`;
        if (assistantMessage) {
            // Truncate if too long
            const truncatedResponse = assistantMessage.length > 500
                ? assistantMessage.substring(0, 500) + '...'
                : assistantMessage;
            chatHistory += `\nAssistant: ${truncatedResponse}`;
        }

        const prompt = TITLE_PROMPT.replace('{{MESSAGE}}', chatHistory);

        try {
            const messages = [{ role: 'user', content: prompt }];
            console.log('[TitleService] Generating title with model:', model);

            // Use non-streaming for title generation
            const response = await fetch(`${ollamaService.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages,
                    stream: false
                })
            });

            console.log('[TitleService] Response status:', response.status);

            if (!response.ok) {
                throw new Error(`Title generation failed: ${response.statusText}`);
            }

            const data = await response.json();
            const content = data.message?.content || '';
            console.log('[TitleService] AI response content:', content);

            const title = this.parseTitle(content, userMessage);
            console.log('[TitleService] Parsed title:', title);
            return title;
        } catch (error) {
            console.error('[TitleService] Title generation error:', error);
            // Fallback to simple title extraction
            return this.fallbackTitle(userMessage);
        }
    }

    /**
     * Parse the title from AI response
     * @param {string} content - AI response content
     * @param {string} fallbackMessage - Fallback message for title
     * @returns {string}
     */
    parseTitle(content, fallbackMessage) {
        try {
            // Try to extract JSON from the response
            const jsonMatch = content.match(/\{[\s\S]*"title"[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.title && parsed.title.trim()) {
                    return parsed.title.trim();
                }
            }

            // If no valid JSON, try to use the content directly if short enough
            const cleaned = content.replace(/[{}"]/g, '').trim();
            if (cleaned.length > 0 && cleaned.length < 60) {
                return cleaned;
            }
        } catch (e) {
            console.warn('Failed to parse title JSON:', e);
        }

        return this.fallbackTitle(fallbackMessage);
    }

    /**
     * Generate a simple fallback title
     * @param {string} message - User message
     * @returns {string}
     */
    fallbackTitle(message) {
        const maxLength = 40;
        const cleaned = message.trim().replace(/\n/g, ' ');
        return cleaned.length > maxLength
            ? cleaned.substring(0, maxLength) + '...'
            : cleaned;
    }
}

// Export singleton instance
export const titleService = new TitleService();

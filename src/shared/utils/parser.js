/**
 * Parser utilities — extract structured data from AI responses
 */

import { Logger } from './logger.js';

export const Parser = {
  /**
   * Deep-clean a JSON string to fix common ChatGPT output issues:
   * - Smart quotes → regular quotes
   * - Em/en dashes → regular dashes
   * - Trailing commas before } or ]
   * - Unescaped newlines/tabs inside string values
   * - Control characters
   * - Non-breaking spaces
   */
  _cleanJSON(raw) {
    let s = raw;
    // Em dash, en dash → regular dash
    s = s.replace(/[\u2014\u2013]/g, '-');
    // Ellipsis character → three dots
    s = s.replace(/\u2026/g, '...');
    // Non-breaking space → regular space
    s = s.replace(/\u00A0/g, ' ');
    // Trailing commas before } or ]
    s = s.replace(/,\s*}/g, '}');
    s = s.replace(/,\s*]/g, ']');
    // Walk through char by char, track if we're inside a string.
    // Smart quotes OUTSIDE strings → regular quotes (structural JSON).
    // Smart quotes INSIDE strings → escaped regular quotes or apostrophes
    //   (replacing with unescaped " would break the JSON string boundary).
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = ch.charCodeAt(0);
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        result += ch;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        result += ch;
        continue;
      }
      // Smart double quotes: \u201C \u201D \u201E \u201F \u2033 \u2036
      if ('\u201C\u201D\u201E\u201F\u2033\u2036'.includes(ch)) {
        if (inString) {
          result += '\\"'; // escape inside strings
        } else {
          result += '"'; // structural quote outside strings
          inString = !inString;
        }
        continue;
      }
      // Smart single quotes / apostrophes: \u2018 \u2019 \u201A \u201B \u2032 \u2035
      if ('\u2018\u2019\u201A\u201B\u2032\u2035'.includes(ch)) {
        result += "'"; // always safe as apostrophe
        continue;
      }
      if (inString) {
        // Replace raw newlines/tabs inside strings with escaped versions
        if (ch === '\n') { result += '\\n'; continue; }
        if (ch === '\r') { continue; } // skip carriage returns
        if (ch === '\t') { result += '\\t'; continue; }
        // Remove other control characters inside strings
        if (code < 32) { result += ' '; continue; }
      }
      result += ch;
    }
    return result;
  },

  extractJSON(text) {
    if (!text || typeof text !== 'string') return null;

    // Pre-clean: remove common ChatGPT prefixes like "JSON{", "json{", "Here is the JSON:"
    text = text.replace(/^[\s]*(?:JSON|json|Json)\s*(?=\{)/i, '');

    // Define parsing strategies as an ordered list
    const strategies = [
      {
        label: 'JSON block',
        extract: (t) => {
          const m = t.match(/```json\s*([\s\S]*?)```/);
          return m ? m[1].trim() : null;
        }
      },
      {
        label: 'Code block',
        extract: (t) => {
          const m = t.match(/```\s*([\s\S]*?)```/);
          return m ? m[1].trim() : null;
        }
      },
      {
        label: 'Direct extraction',
        extract: (t) => {
          const m = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
          return m ? m[1].trim() : null;
        }
      }
    ];

    // Try each strategy: first raw, then with deep cleaning
    for (const { label, extract } of strategies) {
      const candidate = extract(text);
      if (!candidate) continue;

      // Try raw first
      try {
        return JSON.parse(candidate);
      } catch (e) {
        Logger.debug(`${label} raw parse failed: ${e.message}`);
      }

      // Try with deep cleaning
      try {
        const cleaned = this._cleanJSON(candidate);
        return JSON.parse(cleaned);
      } catch (e) {
        Logger.warn(`${label} cleaned parse failed: ${e.message}`);
      }
    }

    Logger.error('All JSON extraction attempts failed');
    return null;
  },

  sanitizeFolderName(name) {
    return name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
  }
};

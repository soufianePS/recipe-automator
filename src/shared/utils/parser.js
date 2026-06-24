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
        if (inString) {
          // Is this really the end of the string, or an unescaped quote inside it?
          // Look ahead: if next non-whitespace char is a JSON structural char, it's the real end
          let j = i + 1;
          while (j < s.length && (s[j] === ' ' || s[j] === '\n' || s[j] === '\r' || s[j] === '\t')) j++;
          const nextChar = s[j] || '';
          if (':,}]'.includes(nextChar)) {
            // Real end of string
            inString = false;
            result += ch;
          } else {
            // Unescaped quote inside string — escape it
            result += '\\"';
          }
        } else {
          inString = true;
          result += ch;
        }
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

  /**
   * Aggressive recovery for JSON with localized syntax errors. Walks parse
   * errors and tries common fixes:
   *   - "Expected ',' or ']' after array element" → insert comma at error pos
   *   - "Expected ',' or '}' after property value" → insert comma
   *   - "Unexpected non-whitespace character after JSON" → trim trailing junk
   * Caps at 20 fix attempts to avoid infinite loops.
   */
  _recoverJSON(raw) {
    let s = raw;
    for (let i = 0; i < 20; i++) {
      try {
        return JSON.parse(s);
      } catch (e) {
        const msg = e.message;
        const posMatch = msg.match(/position\s+(\d+)/);
        if (!posMatch) return null;
        const pos = parseInt(posMatch[1], 10);

        if (/Expected ',' or '\]'|Expected ',' or '\}'/.test(msg)) {
          // Insert a comma at error position
          s = s.slice(0, pos) + ',' + s.slice(pos);
          continue;
        }
        if (/Unexpected non-whitespace character after JSON/.test(msg)) {
          // Trim trailing junk after the parsed JSON
          s = s.slice(0, pos);
          continue;
        }
        if (/Unexpected token .* in JSON|Unexpected end of JSON input/.test(msg)) {
          // Try to find the last balanced }/] before pos and truncate there
          const cut = this._findLastBalancedBrace(s, pos);
          if (cut > 0 && cut < s.length) { s = s.slice(0, cut + 1); continue; }
          return null;
        }
        return null;
      }
    }
    return null;
  },

  /**
   * Last-resort salvage for a TRUNCATED JSON (stream cut off mid-recipe):
   * close any unterminated string, drop a dangling trailing comma, fill a
   * dangling "key": with null, and append the missing }/] in LIFO order so the
   * partial object becomes parseable. Recovers most of a cut-off recipe.
   */
  _autoClose(raw) {
    let s = String(raw);
    const stack = [];
    let inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') stack.push('}');
      else if (c === '[') stack.push(']');
      else if (c === '}' || c === ']') stack.pop();
    }
    let res = s;
    if (inStr) res += '"';                 // close unterminated string
    res = res.replace(/\s+$/, '');         // trim trailing whitespace
    res = res.replace(/,$/, '');           // drop dangling comma
    if (/:$/.test(res)) res += ' null';    // key with no value yet
    res = res.replace(/,$/, '');
    while (stack.length) res += stack.pop(); // append missing closers (LIFO)
    return res;
  },

  /** Walks back from `from` and returns the index of the last balanced } or ]. */
  _findLastBalancedBrace(s, from) {
    let depth = 0, lastBalanced = -1;
    for (let i = 0; i < Math.min(from, s.length); i++) {
      const c = s[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) lastBalanced = i; }
    }
    return lastBalanced;
  },

  extractJSON(text) {
    if (!text || typeof text !== 'string') return null;

    // Pre-clean: strip Gemini/ChatGPT UI prefixes that get scraped into innerText.
    // Gemini wraps responses with "Gemini a dit" / "Gemini said" labels on
    // model-response containers — those get pulled in by querySelector text
    // extraction and confuse downstream regexes.
    text = text
      .replace(/^[\s]*Gemini\s+(?:a\s+dit|said)[\s:]*/i, '')
      .replace(/^[\s]*(?:JSON|json|Json)\s*(?=\{)/i, '');

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
      },
      {
        // Truncated tail: grab from the FIRST opening brace to END of text (no
        // closing required). Lets _autoClose salvage a recipe whose stream was
        // cut off mid-array (the greedy regex above stops at the last complete
        // '}' and drops the partial steps; this keeps them).
        label: 'Truncated tail',
        extract: (t) => {
          const io = t.indexOf('{'), ia = t.indexOf('[');
          const i = (io === -1) ? ia : (ia === -1 ? io : Math.min(io, ia));
          return i === -1 ? null : t.slice(i).trim();
        }
      }
    ];

    // Try each strategy: raw → cleaned → recovered
    for (const { label, extract } of strategies) {
      const candidate = extract(text);
      if (!candidate) continue;

      try {
        return JSON.parse(candidate);
      } catch (e) {
        Logger.debug(`${label} raw parse failed: ${e.message}`);
      }

      try {
        const cleaned = this._cleanJSON(candidate);
        return JSON.parse(cleaned);
      } catch (e) {
        Logger.debug(`${label} cleaned parse failed: ${e.message}`);
        // Try aggressive recovery on the cleaned candidate — fixes most
        // missing-comma / trailing-junk errors that previously failed the run.
        const recovered = this._recoverJSON(this._cleanJSON(candidate));
        if (recovered) {
          Logger.warn(`${label} recovered after JSON fix-up`);
          return recovered;
        }
        // Last resort: the JSON is likely TRUNCATED (stream cut off). Auto-close
        // the open braces/strings and retry — salvages a partial recipe instead
        // of failing the whole run.
        const salvaged = this._recoverJSON(this._autoClose(this._cleanJSON(candidate)));
        if (salvaged) {
          Logger.warn(`${label} salvaged after auto-closing a truncated JSON`);
          return salvaged;
        }
        Logger.warn(`${label} recovery failed: ${e.message}`);
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

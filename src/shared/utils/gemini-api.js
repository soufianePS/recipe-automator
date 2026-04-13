/**
 * Gemini API — lightweight wrapper for Google Gemini vision API.
 * Used by the verified-generator module to validate generated images.
 *
 * Free tier: 15 req/min, 1500 req/day (gemini-2.5-flash).
 */

import { readFileSync } from 'fs';
import { Logger } from './logger.js';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Send an image + text prompt to Gemini and get a structured JSON response.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to image file on disk
 * @param {string} prompt — text prompt (verifier/analysis)
 * @param {object} [options]
 * @param {number} [options.temperature=0.1]
 * @param {number} [options.maxTokens=800]
 * @param {number} [options.timeoutMs=30000]
 * @returns {object|null} parsed JSON response, or null on failure
 */
export async function geminiVision(apiKey, imagePath, prompt, options = {}) {
  const { temperature = 0.1, maxTokens = 4000, timeoutMs = 30000, maxRetries = 2 } = options;

  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const url = `${API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  };

  // Retry loop for transient errors (high demand, rate limit)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errMsg = errBody?.error?.message || `HTTP ${res.status}`;

        // Retry on high demand / rate limit (429 or 503)
        if ((res.status === 429 || res.status === 503 || errMsg.includes('high demand')) && attempt < maxRetries) {
          const delay = (attempt + 1) * 15000; // 15s, 30s
          Logger.warn(`[Gemini] ${errMsg} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (errMsg.includes('high demand') || errMsg.includes('quota') || res.status === 503 || res.status === 429) {
          Logger.warn(`[Gemini] Temporarily unavailable: ${errMsg.substring(0, 100)}`);
        } else {
          Logger.error(`[Gemini] API error: ${errMsg}`);
        }
        return null;
      }

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      Logger.error('[Gemini] Empty response from API');
      return null;
    }

    // Parse JSON — strip markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch (parseErr) {
      Logger.warn(`[Gemini] Failed to parse JSON response: ${cleaned.substring(0, 200)}`);
      return null;
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      Logger.error('[Gemini] Request timed out');
    } else {
      Logger.error(`[Gemini] Request failed: ${err.message}`);
    }
    return null;
  }
  } // end retry loop

  return null; // all retries exhausted
}

/**
 * Send multiple images + text prompt to Gemini (for comparison).
 *
 * @param {string} apiKey
 * @param {string[]} imagePaths — array of image file paths
 * @param {string} prompt
 * @param {object} [options]
 * @returns {object|null} parsed JSON response
 */
export async function geminiVisionMultiImage(apiKey, imagePaths, prompt, options = {}) {
  const { temperature = 0.1, maxTokens = 2000, timeoutMs = 30000, maxRetries = 2 } = options;

  const parts = [];
  for (const imgPath of imagePaths) {
    const imageData = readFileSync(imgPath);
    const base64 = imageData.toString('base64');
    const mimeType = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    parts.push({ inlineData: { mimeType, data: base64 } });
  }
  parts.push({ text: prompt });

  const url = `${API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errMsg = errBody?.error?.message || `HTTP ${res.status}`;
        if ((res.status === 429 || res.status === 503 || errMsg.includes('high demand')) && attempt < maxRetries) {
          const delay = (attempt + 1) * 5000;
          Logger.warn(`[Gemini] ${errMsg} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (errMsg.includes('high demand') || errMsg.includes('quota') || res.status === 503 || res.status === 429) {
          Logger.warn(`[Gemini] Temporarily unavailable: ${errMsg.substring(0, 100)}`);
        } else {
          Logger.error(`[Gemini] API error: ${errMsg}`);
        }
        return null;
      }

      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { Logger.error('[Gemini] Empty response'); return null; }

      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      try { return JSON.parse(cleaned); }
      catch { Logger.warn(`[Gemini] Failed to parse: ${cleaned.substring(0, 200)}`); return null; }
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') Logger.error('[Gemini] Request timed out');
      else Logger.error(`[Gemini] Request failed: ${err.message}`);
      return null;
    }
  }
  return null;
}

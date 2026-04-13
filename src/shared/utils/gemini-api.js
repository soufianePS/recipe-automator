/**
 * Gemini API — lightweight wrapper for Google Gemini vision API.
 * Uses model rotation: when one model hits rate/quota limit, falls back to next.
 *
 * Free tier limits per key:
 *   gemini-3.1-flash-lite-preview: 15 RPM, 500 RPD (primary — highest volume)
 *   gemini-3-flash-preview:         5 RPM,  20 RPD (best accuracy)
 *   gemini-2.5-flash:               5 RPM,  20 RPD (fallback)
 *   Total with rotation: 25 RPM, 540 RPD per key
 */

import { readFileSync } from 'fs';
import { Logger } from './logger.js';

// Models in priority order: highest free volume first, best accuracy second
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite-preview',  // 15 RPM, 500 RPD
  'gemini-3-flash-preview',          //  5 RPM,  20 RPD
  'gemini-2.5-flash',                //  5 RPM,  20 RPD
];
let _currentModelIndex = 0;

function _getNextModel() {
  const model = GEMINI_MODELS[_currentModelIndex % GEMINI_MODELS.length];
  _currentModelIndex++;
  return model;
}

function _rotateOnError() {
  _currentModelIndex++;
  const next = GEMINI_MODELS[_currentModelIndex % GEMINI_MODELS.length];
  Logger.info(`[Gemini] Rotating to model: ${next}`);
  return next;
}

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
  const { temperature = 0.1, maxTokens = 4000, timeoutMs = 30000 } = options;

  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const requestBody = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64 } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };

  // Try each model — if one hits rate limit, rotate to next
  for (let modelAttempt = 0; modelAttempt < GEMINI_MODELS.length; modelAttempt++) {
    const model = GEMINI_MODELS[(_currentModelIndex + modelAttempt) % GEMINI_MODELS.length];
    const url = `${API_BASE}/${model}:generateContent?key=${apiKey}`;

    // Retry loop for transient errors (high demand)
    for (let retry = 0; retry <= 1; retry++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const errMsg = errBody?.error?.message || `HTTP ${res.status}`;
          const isRateLimit = res.status === 429 || errMsg.includes('quota');
          const isHighDemand = res.status === 503 || errMsg.includes('high demand');

          if (isRateLimit) {
            // Rate/quota limit — try next MODEL immediately
            Logger.warn(`[Gemini] ${model} rate limited — rotating to next model`);
            break; // break retry loop, continue model loop
          }

          if (isHighDemand && retry === 0) {
            // High demand — wait and retry same model once
            Logger.warn(`[Gemini] ${model} high demand — retrying in 10s`);
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }

          // Final failure for this model
          Logger.warn(`[Gemini] ${model}: ${errMsg.substring(0, 100)}`);
          break; // try next model
        }

        // Success — parse response
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          Logger.warn(`[Gemini] ${model} returned empty response`);
          break; // try next model
        }

        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        try {
          // Success! Update current model index for next call
          _currentModelIndex = (_currentModelIndex + modelAttempt) % GEMINI_MODELS.length;
          return JSON.parse(cleaned);
        } catch (parseErr) {
          Logger.warn(`[Gemini] ${model} failed to parse JSON: ${cleaned.substring(0, 200)}`);
          return null;
        }
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') Logger.warn(`[Gemini] ${model} timed out`);
        else Logger.warn(`[Gemini] ${model} request failed: ${err.message}`);
        break; // try next model
      }
    } // end retry loop
  } // end model loop

  Logger.warn('[Gemini] All models exhausted — no result');
  return null;
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
  const { temperature = 0.1, maxTokens = 2000, timeoutMs = 30000 } = options;

  const parts = [];
  for (const imgPath of imagePaths) {
    const imageData = readFileSync(imgPath);
    const base64 = imageData.toString('base64');
    const mimeType = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    parts.push({ inlineData: { mimeType, data: base64 } });
  }
  parts.push({ text: prompt });

  const requestBody = {
    contents: [{ parts }],
    generationConfig: { temperature, maxOutputTokens: maxTokens }
  };

  // Try each model — rotate on rate limit
  for (let modelAttempt = 0; modelAttempt < GEMINI_MODELS.length; modelAttempt++) {
    const model = GEMINI_MODELS[(_currentModelIndex + modelAttempt) % GEMINI_MODELS.length];
    const url = `${API_BASE}/${model}:generateContent?key=${apiKey}`;

    for (let retry = 0; retry <= 1; retry++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        clearTimeout(timer);

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          const errMsg = errBody?.error?.message || `HTTP ${res.status}`;

          if (res.status === 429 || errMsg.includes('quota')) {
            Logger.warn(`[Gemini] ${model} rate limited — rotating to next model`);
            break;
          }
          if ((res.status === 503 || errMsg.includes('high demand')) && retry === 0) {
            Logger.warn(`[Gemini] ${model} high demand — retrying in 10s`);
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
          Logger.warn(`[Gemini] ${model}: ${errMsg.substring(0, 100)}`);
          break;
        }

        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { Logger.warn(`[Gemini] ${model} empty response`); break; }

        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        try {
          _currentModelIndex = (_currentModelIndex + modelAttempt) % GEMINI_MODELS.length;
          return JSON.parse(cleaned);
        }
        catch { Logger.warn(`[Gemini] ${model} failed to parse: ${cleaned.substring(0, 200)}`); return null; }
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') Logger.warn(`[Gemini] ${model} timed out`);
        else Logger.warn(`[Gemini] ${model} failed: ${err.message}`);
        break;
      }
    }
  }

  Logger.warn('[Gemini] All models exhausted — no result');
  return null;
}

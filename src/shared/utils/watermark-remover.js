/**
 * Gemini watermark remover — wraps @pilio/gemini-watermark-remover with a
 * sharp-based codec so we can call it from Node.
 *
 * Strategy: reverse alpha blending. Gemini's visible watermark is composited
 * with a known glyph at known alpha. The library captures that glyph's alpha
 * map against a known background and applies the inverse formula:
 *
 *     original = (watermarked - α·logo) / (1 - α)
 *
 * No ML hallucination — pixels are recovered, not invented. Works for any
 * Gemini output dimension via the bundled size catalog + adaptive detector.
 *
 * Usage from the orchestrator / page driver:
 *
 *     import { removeWatermarkInPlace } from '../utils/watermark-remover.js';
 *     await removeWatermarkInPlace('/abs/path/to/image.webp');
 *
 * Failure mode: NEVER throws back to the caller. If removal fails (corrupt
 * file, no detected watermark, sharp not built for this platform), the
 * original file is left untouched and a warning is logged. This guarantees
 * the recipe pipeline can never break because of watermark removal alone.
 */

import { removeWatermarkFromFile } from '@pilio/gemini-watermark-remover/node';
import sharp from 'sharp';
import { Logger } from './logger.js';

/** Build the sharp codec the SDK needs (mirrors gwrRemoveCommand.js). */
function makeSharpCodec() {
  return {
    async decodeImageData(buffer) {
      const { data, info } = await sharp(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        width: info.width,
        height: info.height,
        data: Uint8ClampedArray.from(data),
      };
    },
    async encodeImageData(imageData, context = {}) {
      const fmt = resolveOutputFormat(context.mimeType, context.filePath);
      let encoder = sharp(Buffer.from(imageData.data), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 },
      });
      if (fmt === 'jpeg') encoder = encoder.jpeg({ quality: 95 });
      else if (fmt === 'webp') encoder = encoder.webp({ quality: 95 });
      else encoder = encoder.png();
      return encoder.toBuffer();
    },
  };
}

function resolveOutputFormat(mimeType, filePath) {
  const mt = (mimeType || '').toLowerCase();
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpeg';
  if (mt.includes('webp')) return 'webp';
  if (mt.includes('png')) return 'png';
  const ext = (filePath || '').toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'webp') return 'webp';
  return 'png';
}

/**
 * Remove the Gemini watermark from `filePath` and overwrite in place.
 * Returns true on success, false on any failure (caller should not depend on this).
 */
export async function removeWatermarkInPlace(filePath) {
  if (!filePath) return false;
  try {
    const codec = makeSharpCodec();
    const result = await removeWatermarkFromFile(filePath, {
      outputPath: filePath, // overwrite in place
      ...codec,
    });
    const meta = result?.meta || {};
    if (meta.applied) {
      const pos = meta.position;
      const tier = meta.decisionTier || 'unknown';
      const reason = meta.passStopReason || '?';
      Logger.info(
        `[Watermark] stripped ${shortPath(filePath)} ` +
        `(${pos ? `at ${pos.x},${pos.y} ${pos.width}×${pos.height}` : 'pos:?'}, ` +
        `tier=${tier}, ${reason})`
      );
    } else {
      Logger.debug(`[Watermark] no watermark detected in ${shortPath(filePath)} (${meta.skipReason || 'no-match'})`);
    }
    return meta.applied === true;
  } catch (e) {
    // Never throw — pipeline must not break on watermark removal.
    const msg = e?.message?.split('\n')[0] || String(e);
    Logger.warn(`[Watermark] removal failed for ${shortPath(filePath)} — keeping original. Reason: ${msg}`);
    return false;
  }
}

function shortPath(p) {
  return p ? p.split(/[\\/]/).slice(-2).join('/') : '(no path)';
}

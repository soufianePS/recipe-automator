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
 *
 * If detection fails on the first pass we retry with PNG encoding — the
 * rationale: WebP/JPEG re-encoding shifts watermark pixels just enough that
 * the alpha-blend formula's confidence threshold rejects the match. PNG keeps
 * the pixels exact and lets the detector lock on. We re-write the original
 * file in its original format afterwards.
 */
export async function removeWatermarkInPlace(filePath) {
  if (!filePath) return false;
  try {
    const codec = makeSharpCodec();
    let result = await removeWatermarkFromFile(filePath, {
      outputPath: filePath,
      ...codec,
    });
    let meta = result?.meta || {};

    // Retry with PNG codec if the first attempt couldn't detect a watermark.
    if (!meta.applied) {
      Logger.warn(`[Watermark] first pass found NO watermark in ${shortPath(filePath)} — retrying with PNG codec`);
      const pngCodec = {
        decodeImageData: codec.decodeImageData,
        async encodeImageData(imageData) {
          return sharp(Buffer.from(imageData.data), {
            raw: { width: imageData.width, height: imageData.height, channels: 4 },
          }).png().toBuffer();
        },
      };
      // Strip into a temp PNG file, then re-encode back to the original format.
      const tmpPng = filePath + '.wm-retry.png';
      result = await removeWatermarkFromFile(filePath, {
        outputPath: tmpPng,
        mimeType: 'image/png',
        ...pngCodec,
      });
      meta = result?.meta || {};
      if (meta.applied) {
        // Re-encode tmpPng back into the original filePath as the original format
        const originalFmt = resolveOutputFormat(null, filePath);
        let buf;
        try {
          const tmpBuf = await sharp(tmpPng).toBuffer(); // input is PNG
          let encoder = sharp(tmpBuf);
          if (originalFmt === 'jpeg') buf = await encoder.jpeg({ quality: 95 }).toBuffer();
          else if (originalFmt === 'webp') buf = await encoder.webp({ quality: 95 }).toBuffer();
          else buf = await encoder.png().toBuffer();
          // Overwrite original
          (await import('fs')).writeFileSync(filePath, buf);
        } finally {
          try { (await import('fs')).unlinkSync(tmpPng); } catch {}
        }
      } else {
        try { (await import('fs')).unlinkSync(tmpPng); } catch {}
      }
    }

    if (meta.applied) {
      const pos = meta.position;
      const tier = meta.decisionTier || 'unknown';
      const reason = meta.passStopReason || '?';
      Logger.info(
        `[Watermark] stripped ${shortPath(filePath)} ` +
        `(${pos ? `at ${pos.x},${pos.y} ${pos.width}×${pos.height}` : 'pos:?'}, ` +
        `tier=${tier}, ${reason})`
      );
      // The SDK's alpha-blend pass usually clears the main glyph but Gemini
      // composites a small "sparkle" over the same corner that the SDK's
      // safety-near-black / residual-low stop reasons leave behind. Blur a
      // slightly larger area than the SDK reported to wipe any residue.
      // Soft cost: a ~5% bottom-right corner becomes smooth — invisible on
      // food photos (plate / surface / blurred bg fills the corner anyway).
      try {
        await blurResidualCorner(filePath, pos);
      } catch (e) {
        Logger.warn(`[Watermark] residual-corner blur failed: ${e?.message?.split('\n')[0]}`);
      }
    } else {
      // Bumped from debug → warn so silent failures are visible. If we keep
      // seeing this on real runs, the SDK's catalog needs updating for our
      // image dimensions or Gemini changed the watermark glyph.
      Logger.warn(`[Watermark] NO WATERMARK STRIPPED for ${shortPath(filePath)} (${meta.skipReason || 'detector returned no match'}) — file uploaded as-is`);
    }
    return meta.applied === true;
  } catch (e) {
    const msg = e?.message?.split('\n')[0] || String(e);
    Logger.warn(`[Watermark] removal failed for ${shortPath(filePath)} — keeping original. Reason: ${msg}`);
    return false;
  }
}

function shortPath(p) {
  return p ? p.split(/[\\/]/).slice(-2).join('/') : '(no path)';
}

/**
 * Re-encode the bottom-right corner of the image as a heavily-blurred patch.
 * Targets the SDK-reported watermark position (with margin) when available,
 * otherwise a default ~6% corner. Fixes the residual "sparkle" that Gemini
 * draws over the watermark area which the SDK's alpha-blend doesn't catch.
 */
async function blurResidualCorner(filePath, pos) {
  const img = sharp(filePath);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return;

  const fmt = resolveOutputFormat(null, filePath);

  // Build the blur region. If the SDK reported a position, expand it ~60%
  // in each direction to cover sparkle pixels just outside the matched glyph.
  // Otherwise default to a 7% bottom-right corner which covers Gemini's
  // standard watermark zone for any aspect ratio.
  let left, top, w, h;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    const padX = Math.round(pos.width * 0.6);
    const padY = Math.round(pos.height * 0.6);
    left = Math.max(0, pos.x - padX);
    top  = Math.max(0, pos.y - padY);
    w = Math.min(meta.width  - left, pos.width  + padX * 2);
    h = Math.min(meta.height - top,  pos.height + padY * 2);
  } else {
    w = Math.max(60, Math.round(meta.width  * 0.07));
    h = Math.max(60, Math.round(meta.height * 0.07));
    left = meta.width  - w;
    top  = meta.height - h;
  }
  if (w < 8 || h < 8) return;

  // Read full image once, extract the corner from a clone, blur it heavily
  // (sigma 18 = aggressive smoothing — a sparkle becomes a smooth gradient),
  // then composite back over the original at the same coords.
  const fullBuf = await sharp(filePath).toBuffer();
  const cornerBuf = await sharp(fullBuf)
    .extract({ left, top, width: w, height: h })
    .blur(18)
    .png()
    .toBuffer();

  let composer = sharp(fullBuf).composite([{ input: cornerBuf, left, top }]);
  if (fmt === 'jpeg') composer = composer.jpeg({ quality: 95 });
  else if (fmt === 'webp') composer = composer.webp({ quality: 95 });
  else composer = composer.png();

  const outBuf = await composer.toBuffer();
  (await import('fs')).writeFileSync(filePath, outBuf);
  Logger.info(`[Watermark] residual-corner blurred at ${left},${top} ${w}×${h}`);
}

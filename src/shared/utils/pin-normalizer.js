// Normalize any Pinterest pin image to a clean 2:3 vertical aspect ratio.
// Pinterest's optimal display ratio is 2:3 (1000×1500). ChatGPT's native picker
// only offers 3:4 (1024×1365), and Flow output can drift. Without this,
// recipes generated different days have inconsistent visual heights in the feed.
//
// Strategy: center-crop the larger dimension. Never letterbox/pad — pins must
// be edge-to-edge, no white borders. Loss = ~10% of the cropped axis (sides
// for 3:4 inputs, top+bottom for 9:16 inputs). The prompt instructs the model
// to keep critical content (text, food) in the central 80%, so the crop is safe.
//
// Quality: Lanczos3 resampling (sharp default) is photographically lossless
// for the small upscale from 910→1000 (~10%). Output JPEG q=92 ≈ source.

import sharp from 'sharp';
import { Logger } from './logger.js';

const TARGET_W = 1000;
const TARGET_H = 1500;
const TARGET_RATIO = TARGET_W / TARGET_H;   // 0.6667
const RATIO_TOLERANCE = 0.01;                // already-2:3 → no extract

/**
 * Convert any pin image to 1000×1500 (2:3 vertical). Overwrites in place
 * if output path matches input. Always emits JPEG.
 *
 * Returns { converted: bool, original: {w,h,ratio}, final: {w,h}, action: 'skip'|'crop-width'|'crop-height' }
 */
export async function normalizePinTo2x3(inputPath, outputPath = inputPath) {
  const img = sharp(inputPath);
  const meta = await img.metadata();
  const { width: w, height: h } = meta;
  if (!w || !h) {
    Logger.warn(`[PinNormalize] could not read dimensions of ${inputPath} — skipping`);
    return { converted: false, reason: 'no-dimensions' };
  }
  const currentRatio = w / h;
  const original = { w, h, ratio: Number(currentRatio.toFixed(3)) };

  // Already 2:3 (within tolerance) — just resize to canonical 1000×1500
  if (Math.abs(currentRatio - TARGET_RATIO) < RATIO_TOLERANCE) {
    // If size already matches target, no-op (avoid re-encoding).
    // Copy when output path differs from input — callers expect a file there.
    if (w === TARGET_W && h === TARGET_H) {
      Logger.info(`[PinNormalize] ${inputPath} already 1000×1500 (2:3) — no-op`);
      if (outputPath !== inputPath) {
        const { copyFile } = await import('fs/promises');
        await copyFile(inputPath, outputPath);
      }
      return { converted: false, original, final: { w, h }, action: 'skip' };
    }
    const buf = await img
      .resize(TARGET_W, TARGET_H, { fit: 'fill' })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, buf);
    Logger.info(`[PinNormalize] ${original.w}×${original.h} (2:3) → resized to 1000×1500`);
    return { converted: true, original, final: { w: TARGET_W, h: TARGET_H }, action: 'resize-only' };
  }

  let extracted;
  let action;
  if (currentRatio > TARGET_RATIO) {
    // Too wide (3:4, 4:3, 1:1, 16:9, …) → crop sides
    const newW = Math.round(h * TARGET_RATIO);
    const left = Math.round((w - newW) / 2);
    extracted = await img.extract({ left, top: 0, width: newW, height: h }).toBuffer();
    action = 'crop-width';
    Logger.info(`[PinNormalize] ${w}×${h} (ratio ${original.ratio}, wider than 2:3) → cropped width to ${newW}×${h}, then resize to 1000×1500`);
  } else {
    // Too tall (9:16, 1:2, Story, …) → crop top+bottom
    const newH = Math.round(w / TARGET_RATIO);
    const top = Math.round((h - newH) / 2);
    extracted = await img.extract({ left: 0, top, width: w, height: newH }).toBuffer();
    action = 'crop-height';
    Logger.info(`[PinNormalize] ${w}×${h} (ratio ${original.ratio}, taller than 2:3) → cropped height to ${w}×${newH}, then resize to 1000×1500`);
  }

  // Step 2: resize the (now correctly-2:3) crop to canonical 1000×1500
  const buf = await sharp(extracted)
    .resize(TARGET_W, TARGET_H, { fit: 'fill' })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  const { writeFile } = await import('fs/promises');
  await writeFile(outputPath, buf);

  return { converted: true, original, final: { w: TARGET_W, h: TARGET_H }, action };
}

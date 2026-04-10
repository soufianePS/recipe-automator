/**
 * Downloader — fetch images from URLs and convert to base64
 *
 * Used to download recipe images for upload to WordPress or image generation tools.
 */

import { Logger } from '../../shared/utils/logger.js';

// Timeout for individual image downloads (ms)
const DOWNLOAD_TIMEOUT = 15000;

export const Downloader = {
  /**
   * Fetch a single image URL and return its contents as a base64 string.
   *
   * @param {string} imageUrl - The URL to fetch
   * @returns {string|null} Base64-encoded image data, or null on error
   */
  async fetchImageAsBase64(imageUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

      const resp = await fetch(imageUrl, {
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        Logger.debug(`Download failed (${resp.status}): ${imageUrl.substring(0, 80)}`);
        return null;
      }

      const arrayBuffer = await resp.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');

      Logger.debug(`Downloaded ${(arrayBuffer.byteLength / 1024).toFixed(1)} KB: ${imageUrl.substring(0, 80)}`);
      return base64;
    } catch (err) {
      Logger.debug(`Download error: ${imageUrl.substring(0, 80)} — ${err.message}`);
      return null;
    }
  },

  /**
   * Download multiple images and return base64 data for successful ones.
   *
   * @param {string[]} urls - Array of image URLs
   * @param {number} [maxCount=10] - Maximum number of images to download
   * @returns {Array<{url: string, base64: string}>} Array of successfully downloaded images
   */
  async downloadMultiple(urls, maxCount = 10) {
    if (!urls || urls.length === 0) return [];

    const toDownload = urls.slice(0, maxCount);
    Logger.info(`Downloading ${toDownload.length} images...`);

    const results = await Promise.allSettled(
      toDownload.map(async (url) => {
        const base64 = await Downloader.fetchImageAsBase64(url);
        if (base64) {
          return { url, base64 };
        }
        return null;
      })
    );

    const downloaded = results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    Logger.info(`Downloaded ${downloaded.length}/${toDownload.length} images successfully`);
    return downloaded;
  },
};

/**
 * WordPress REST API — media upload, post creation, WPRM
 * Migrated from extension — uses node-fetch compatible APIs
 */

import { readFile } from 'fs/promises';
import { StateManager } from './state-manager.js';
import { Logger } from './logger.js';

const WEBP_QUALITY = 92; // High quality — Flow images are already optimized
const WEBP_FORMAT = 'webp';

function parseDurationToMinutes(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 60) + parseInt(match[2] || 0) + Math.ceil(parseInt(match[3] || 0) / 60);
}

function parseQuantity(qty) {
  if (!qty) return { amount: '', unit: '' };
  const str = qty.trim();
  const match = str.match(/^([\d\s./½¼¾⅓⅔⅛⅜⅝⅞]+)\s*(.*)$/);
  if (match) return { amount: match[1].trim(), unit: match[2].trim() };
  return { amount: str, unit: '' };
}

async function fetchWithRetry(url, options, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      // Retry on timeout (408) or server errors (5xx)
      if ((resp.status === 408 || resp.status >= 500) && attempt < maxRetries) {
        Logger.warn(`Request failed (${resp.status}), retrying ${attempt}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, attempt * 5000));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`${options?.method || 'GET'} failed after ${maxRetries} attempts: ${err.message}`);
      }
      Logger.warn(`Network error, retrying ${attempt}/${maxRetries}: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 5000));
    }
  }
}

async function _uploadSingleImage(api, settings, imageKey, stateImage, defaultAlt, recipe, onProgress, progressMsg) {
  if (stateImage?.wpImageId) {
    return stateImage;
  }
  const base64 = await StateManager.getImageData(imageKey);
  if (!base64) {
    return stateImage;
  }
  onProgress?.(progressMsg);
  const seo = recipe?.[`${imageKey}_seo`] || { alt_text: defaultAlt };
  const filename = seo.filename || `${imageKey}.jpg`;
  const media = await api.uploadImage(settings, base64, filename, seo, recipe);
  return { ...stateImage, wpImageId: media.id, wpImageUrl: media.url };
}

export const WordPressAPI = {
  _authHeader(username, appPassword) {
    return 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
  },

  /**
   * Delete a post and all its associated media (images).
   * Finds media by: post content (wp-image-XXX), featured image, and attached media.
   * Only deletes media not used by other posts.
   */
  async deletePostWithMedia(settings, postId) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const auth = { 'Authorization': this._authHeader(wpUsername, wpAppPassword) };

    // 1. Get the post content to find image IDs
    const postResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}`, { headers: auth });
    if (!postResp.ok) throw new Error(`Post ${postId} not found`);
    const post = await postResp.json();

    const mediaIds = new Set();

    // Featured image
    if (post.featured_media) mediaIds.add(post.featured_media);

    // Images in content (wp-image-XXX)
    const matches = (post.content?.rendered || '').match(/wp-image-(\d+)/g) || [];
    for (const m of matches) mediaIds.add(parseInt(m.replace('wp-image-', '')));

    // Attached media
    try {
      const attResp = await fetch(`${wpUrl}/wp-json/wp/v2/media?parent=${postId}&per_page=50`, { headers: auth });
      if (attResp.ok) {
        const atts = await attResp.json();
        for (const a of atts) mediaIds.add(a.id);
      }
    } catch {}

    // Search for pin images by slug pattern
    const slug = post.slug || '';
    if (slug) {
      try {
        const pinResp = await fetch(`${wpUrl}/wp-json/wp/v2/media?search=${encodeURIComponent(slug)}&per_page=20`, { headers: auth });
        if (pinResp.ok) {
          const pins = await pinResp.json();
          for (const p of pins) mediaIds.add(p.id);
        }
      } catch {}
    }

    // 2. Delete the post first
    const delResp = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}?force=true`, {
      method: 'DELETE', headers: auth
    });
    if (!delResp.ok) throw new Error(`Failed to delete post ${postId}`);

    // 3. Delete each media (only if not used elsewhere)
    let deleted = 0;
    for (const mediaId of mediaIds) {
      try {
        const mediaDelResp = await fetch(`${wpUrl}/wp-json/wp/v2/media/${mediaId}?force=true`, {
          method: 'DELETE', headers: auth
        });
        if (mediaDelResp.ok) deleted++;
      } catch {}
    }

    return { postDeleted: true, mediaDeleted: deleted, totalMedia: mediaIds.size };
  },

  /**
   * Fetch existing published posts for internal linking.
   * Returns array of { title, url } for ChatGPT to link to.
   */
  async fetchExistingPosts(settings, maxPosts = 50) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    if (!wpUrl) return [];
    try {
      const resp = await fetch(`${wpUrl}/wp-json/wp/v2/posts?per_page=${maxPosts}&status=publish&_fields=title,link`, {
        headers: { 'Authorization': this._authHeader(wpUsername, wpAppPassword) }
      });
      if (!resp.ok) return [];
      const posts = await resp.json();
      return posts.map(p => ({ title: p.title?.rendered || '', url: p.link || '' })).filter(p => p.title && p.url);
    } catch (e) {
      Logger.debug('Failed to fetch existing posts:', e.message);
      return [];
    }
  },

  async fetchDisplayName(settings) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    try {
      const resp = await fetch(`${wpUrl}/wp-json/wp/v2/users/me`, {
        headers: { 'Authorization': this._authHeader(wpUsername, wpAppPassword) }
      });
      if (resp.ok) {
        const user = await resp.json();
        return user.name || user.slug || wpUsername;
      }
    } catch {}
    return wpUsername;
  },

  async testConnection(settings) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    if (!wpUrl) return { ok: false, error: 'Site URL is empty' };
    if (!wpUsername) return { ok: false, error: 'Username is empty' };
    if (!wpAppPassword) return { ok: false, error: 'Application Password is empty' };

    try {
      const baseResp = await fetch(`${wpUrl}/wp-json/`);
      if (!baseResp.ok) return { ok: false, error: `REST API not reachable (${baseResp.status})` };
    } catch (e) {
      return { ok: false, error: `Cannot reach site: ${e.message}` };
    }

    try {
      const response = await fetch(`${wpUrl}/wp-json/wp/v2/users/me`, {
        headers: { 'Authorization': this._authHeader(wpUsername, wpAppPassword) }
      });
      if (response.ok) {
        const user = await response.json();
        return { ok: true, username: user.name || user.slug };
      }
      const body = await response.text();
      return { ok: false, error: `Auth failed (${response.status}): ${body.substring(0, 200)}` };
    } catch (e) {
      return { ok: false, error: `Connection error: ${e.message}` };
    }
  },

  async uploadImage(settings, base64Data, filename, seoData = {}, recipeJSON = null) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;

    // Convert base64 to WebP using sharp
    let sharp;
    try {
      sharp = (await import('sharp')).default;
    } catch {
      Logger.warn('sharp not available, uploading as JPEG');
    }

    let imageBuffer = Buffer.from(base64Data, 'base64');
    let uploadFilename = filename;

    if (sharp) {
      try {
        const meta = await sharp(imageBuffer).metadata();
        Logger.info(`Image: ${meta.width}x${meta.height} (${(imageBuffer.length / 1024).toFixed(0)}KB)`);
        imageBuffer = await sharp(imageBuffer)[WEBP_FORMAT]({ quality: WEBP_QUALITY }).toBuffer();
        uploadFilename = filename.replace(/\.(jpe?g|png)$/i, '.webp');
        Logger.debug(`Converted to WebP: ${(imageBuffer.length / 1024).toFixed(0)}KB`);
      } catch (e) {
        Logger.warn('WebP conversion failed, using original:', e.message);
      }
    }

    // Build multipart form data manually
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const mimeType = uploadFilename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${uploadFilename}"\r\n`;
    body += `Content-Type: ${mimeType}\r\n\r\n`;

    const prefix = Buffer.from(body, 'utf-8');
    const suffix = Buffer.from(`\r\n`, 'utf-8');

    // Add metadata fields
    let metaFields = '';
    if (seoData.alt_text) {
      metaFields += `--${boundary}\r\nContent-Disposition: form-data; name="alt_text"\r\n\r\n${seoData.alt_text}\r\n`;
    }
    if (seoData.title) {
      metaFields += `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${seoData.title}\r\n`;
    }
    if (seoData.description) {
      metaFields += `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${seoData.description}\r\n`;
      metaFields += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${seoData.description}\r\n`;
    }
    metaFields += `--${boundary}--\r\n`;

    const metaBuffer = Buffer.from(metaFields, 'utf-8');
    const fullBody = Buffer.concat([prefix, imageBuffer, suffix, metaBuffer]);

    const response = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': this._authHeader(wpUsername, wpAppPassword),
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: fullBody
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WP media upload failed: ${response.status} - ${error}`);
    }

    const media = await response.json();
    return { id: media.id, url: media.source_url };
  },

  async findOrCreateCategory(settings, categoryName) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const authHeader = this._authHeader(wpUsername, wpAppPassword);

    const searchResp = await fetchWithRetry(
      `${wpUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}&per_page=100`,
      { headers: { 'Authorization': authHeader } }
    );
    if (searchResp.ok) {
      const cats = await searchResp.json();
      const exact = cats.find(c => c.name.toLowerCase() === categoryName.toLowerCase());
      if (exact) return exact.id;
    }

    const createResp = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: categoryName })
    });
    if (!createResp.ok) {
      const error = await createResp.text();
      if (createResp.status === 400 && error.includes('term_exists')) {
        const match = error.match(/"term_id":(\d+)/);
        if (match) return parseInt(match[1]);
      }
      throw new Error(`Failed to create category "${categoryName}": ${createResp.status}`);
    }
    const newCat = await createResp.json();
    return newCat.id;
  },

  async findOrCreateTag(settings, tagName) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const authHeader = this._authHeader(wpUsername, wpAppPassword);

    const searchResp = await fetchWithRetry(
      `${wpUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}&per_page=100`,
      { headers: { 'Authorization': authHeader } }
    );
    if (searchResp.ok) {
      const tags = await searchResp.json();
      const exact = tags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
      if (exact) return exact.id;
    }

    const createResp = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/tags`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tagName })
    });
    if (!createResp.ok) {
      const error = await createResp.text();
      if (createResp.status === 400 && error.includes('term_exists')) {
        const match = error.match(/"term_id":(\d+)/);
        if (match) return parseInt(match[1]);
      }
      throw new Error(`Failed to create tag "${tagName}": ${createResp.status}`);
    }
    const newTag = await createResp.json();
    return newTag.id;
  },

  async createDraftPost(settings, title, content, featuredImageId = 0, seo = {}, categoryName = '') {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const postData = { title, content, status: 'draft' };
    if (featuredImageId) postData.featured_media = featuredImageId;
    if (seo.slug) postData.slug = seo.slug;

    if (categoryName) {
      try {
        const catId = await this.findOrCreateCategory(settings, categoryName);
        postData.categories = [catId];
      } catch (e) {
        Logger.warn('Category assignment failed:', e.message);
      }
    }

    // Add focus keyword + post title as tags
    {
      try {
        const tagIds = [];
        if (seo.focusKeyword) {
          for (const kw of seo.focusKeyword.split(',').map(k => k.trim()).filter(Boolean)) {
            tagIds.push(await this.findOrCreateTag(settings, kw));
          }
        }
        if (title) {
          tagIds.push(await this.findOrCreateTag(settings, title));
        }
        if (tagIds.length) postData.tags = tagIds;
      } catch (e) {
        Logger.warn('Tag assignment failed:', e.message);
      }
    }

    const meta = {};
    if (seo.metaTitle) meta._yoast_wpseo_title = seo.metaTitle;
    if (seo.metaDescription) meta._yoast_wpseo_metadesc = seo.metaDescription;
    if (seo.focusKeyword) meta._yoast_wpseo_focuskw = seo.focusKeyword;
    if (seo.metaTitle) meta._yoast_wpseo_opengraph_title = seo.metaTitle;
    if (seo.metaDescription) meta._yoast_wpseo_opengraph_description = seo.metaDescription;
    meta._yoast_wpseo_schema_article_type = 'Article';

    if (Object.keys(meta).length > 0) postData.meta = meta;

    const response = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        'Authorization': this._authHeader(wpUsername, wpAppPassword),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(postData)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WP post creation failed: ${response.status} - ${error}`);
    }

    const post = await response.json();
    return {
      id: post.id,
      link: post.link,
      editLink: `${wpUrl}/wp-admin/post.php?post=${post.id}&action=edit`
    };
  },

  async createWPRMRecipe(settings, recipeJSON, state) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const postTitle = recipeJSON?.post_title || state.recipeTitle;
    const intro = recipeJSON?.intro || '';
    const conclusion = recipeJSON?.conclusion || '';
    const prepTime = parseDurationToMinutes(recipeJSON?.prep_time);
    const cookTime = parseDurationToMinutes(recipeJSON?.cook_time);
    const totalTime = parseDurationToMinutes(recipeJSON?.total_time);
    const servings = recipeJSON?.servings || '4';
    const category = recipeJSON?.category || '';
    const cuisine = recipeJSON?.cuisine || '';
    const focusKeyword = recipeJSON?.focus_keyword || '';

    const wprmIngredients = (recipeJSON?.ingredients || [])
      .filter(ing => typeof ing === 'string' ? ing.trim() : ing?.name)
      .map(ing => {
        if (typeof ing === 'string') return { raw: ing };
        const parsed = parseQuantity(ing.quantity || '');
        return { amount: parsed.amount, unit: parsed.unit, name: ing.name || '', notes: ing.notes || '' };
      });

    const instructionsFlat = (state.steps || []).map((step, i) => ({
      uid: i, type: 'instruction', name: step.title || '',
      text: step.description || '', image: step.wpImageId || 0
    }));

    const tags = {};
    if (category) tags.course = [category];
    if (cuisine) tags.cuisine = [cuisine];
    if (focusKeyword) tags.keyword = focusKeyword.split(',').map(k => k.trim());

    const recipeData = {
      title: postTitle, status: 'draft',
      recipe: {
        type: 'food', name: postTitle, summary: recipeJSON?.recipe_card_description || intro, notes: conclusion,
        prep_time: prepTime, cook_time: cookTime, total_time: totalTime,
        servings: String(servings), servings_unit: '',
        image_id: state.heroImage?.wpImageId || 0,
        author_display: 'default',
        ingredients: [{ name: '', ingredients: wprmIngredients }],
        instructions_flat: instructionsFlat, tags, nutrition: {},
        ingredient_links_type: 'global', unit_system: 'default'
      }
    };

    const response = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/wprm_recipe`, {
      method: 'POST',
      headers: {
        'Authorization': this._authHeader(wpUsername, wpAppPassword),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(recipeData)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`WPRM recipe creation failed: ${response.status}`);
    }

    return { id: (await response.json()).id };
  },

  async linkWPRMToPost(settings, recipeId, postId) {
    const { wpUrl, wpUsername, wpAppPassword } = settings;
    const response = await fetchWithRetry(`${wpUrl}/wp-json/wp/v2/wprm_recipe/${recipeId}`, {
      method: 'POST',
      headers: {
        'Authorization': this._authHeader(wpUsername, wpAppPassword),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipe: { parent_post_id: postId } })
    });
    if (!response.ok) throw new Error(`WPRM link failed: ${response.status}`);
  },

  async uploadAllRecipeImages(settings, state, onProgress) {
    const uploads = {};
    const recipe = state.recipeJSON;

    uploads.heroImage = await _uploadSingleImage(
      this, settings, 'hero', state.heroImage,
      state.recipeTitle, recipe, onProgress, 'Uploading hero image...'
    );

    uploads.ingredientsImage = await _uploadSingleImage(
      this, settings, 'ingredients', state.ingredientsImage,
      'Ingredients', recipe, onProgress, 'Uploading ingredients image...'
    );

    const updatedSteps = [...state.steps];
    for (let i = 0; i < updatedSteps.length; i++) {
      const step = updatedSteps[i];
      if (!step.wpImageId) {
        const base64 = await StateManager.getImageData(`step_${i}`);
        if (base64) {
          onProgress?.(`Uploading step ${i + 1}/${updatedSteps.length}...`);
          const seo = step.seo || { alt_text: step.title };
          const filename = seo.filename || `step-${i + 1}.jpg`;
          const media = await this.uploadImage(settings, base64, filename, seo, recipe);
          updatedSteps[i] = { ...step, wpImageId: media.id, wpImageUrl: media.url };
        }
      }
    }
    uploads.steps = updatedSteps;
    return uploads;
  }
};

/**
 * Regen Renderer — builds Gutenberg HTML for an EXISTING post being rewritten.
 *
 * Pure function: takes recipe JSON + existing image refs + section titles +
 * the existing WPRM card id, returns HTML. No WP API calls, no WPRM creation,
 * no Flow uploads. The existing recipe-card stays untouched in WP — we just
 * re-emit the same shortcode so the new post body still references it.
 *
 * Mirrors the block grammar in src/modules/post-builder.js so the rendered
 * output is template-compatible with VG-generated posts.
 */

import { sanitizeAIText } from '../base-orchestrator.js';
import { Logger } from '../../shared/utils/logger.js';

function autoLinkRelatedRecipes(html, relatedPosts) {
  if (!relatedPosts || relatedPosts.length === 0) return html;
  let linked = 0;
  let result = html;
  for (const post of relatedPosts) {
    if (!post.title || !post.url || post.title.length < 5) continue;
    const escapedTitle = post.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `(?<!<a[^>]*>)(?<!href=["'][^"']*)(${escapedTitle})(?![^<]*<\\/a>)`,
      'gi'
    );
    let replaced = false;
    result = result.replace(regex, (match) => {
      if (replaced) return match;
      replaced = true;
      linked++;
      return `<a href="${post.url}">${match}</a>`;
    });
  }
  if (linked > 0) Logger.info(`[Regen/AutoLinker] Added ${linked} internal links`);
  return result;
}

/**
 * @param {object} input
 * @param {object} input.recipe       — recipe JSON from ChatGPT (intro, steps, ...)
 * @param {object} input.existingImages — { hero, ingredients, steps[] } each {wpImageId, wpImageUrl, alt}
 * @param {object} input.sectionTitles — randomized H2 names per section (or {})
 * @param {number} input.recipeCardId   — existing WPRM card ID to reference (or 0)
 * @param {object} input.settings       — site settings (postTemplate etc.)
 * @param {Array}  input.relatedPosts   — for auto-linker
 * @returns {string} Gutenberg HTML
 */
export function renderRegenHTML(input) {
  const { recipe, existingImages, sectionTitles = {}, recipeCardId = 0, settings, relatedPosts = [] } = input;

  const blocks = [];
  const intro = sanitizeAIText(recipe?.intro || '');
  const conclusion = sanitizeAIText(recipe?.conclusion || '');
  const ingredients = recipe?.ingredients || [];

  const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const richText = t => {
    let s = t || '';
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    const safeTags = [];
    s = s.replace(/<(\/?(strong|em|b|i|a|br)\b[^>]*)>/gi, (m) => {
      safeTags.push(m);
      return `__SAFE_${safeTags.length - 1}__`;
    });
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    safeTags.forEach((tag, i) => { s = s.replace(`__SAFE_${i}__`, tag); });
    return s;
  };
  const imgBlock = (url, alt, id) => `<!-- wp:image {"id":${id || 0},"sizeSlug":"large","align":"center","linkDestination":"none"} -->\n<figure class="wp-block-image aligncenter size-large"><img src="${url}" alt="${esc(alt)}" class="wp-image-${id || 0}"/></figure>\n<!-- /wp:image -->`;
  const pBlock = (t, opts = {}) => {
    const cssRules = [
      opts.fontSize ? `font-size:${opts.fontSize}` : '',
      opts.lineHeight ? `line-height:${opts.lineHeight}` : '',
      opts.align ? `text-align:${opts.align}` : '',
      opts.textColor ? `color:${opts.textColor}` : '',
      opts.bgColor ? `background-color:${opts.bgColor};padding:12px` : ''
    ].filter(Boolean).join(';');
    const styleAttr = cssRules ? ` style="${cssRules}"` : '';
    const dropCapClass = opts.dropCap ? ' has-drop-cap' : '';
    let inner = opts.raw ? t : richText(t);
    if (opts.bold) inner = `<strong>${inner}</strong>`;
    if (opts.italic) inner = `<em>${inner}</em>`;
    return `<!-- wp:paragraph -->\n<p${styleAttr}${dropCapClass ? ` class="${dropCapClass.trim()}"` : ''}>${inner}</p>\n<!-- /wp:paragraph -->`;
  };
  const h2Block = t => `<!-- wp:heading -->\n<h2 class="wp-block-heading">${esc(t)}</h2>\n<!-- /wp:heading -->`;
  const h3Block = t => `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${esc(t)}</h3>\n<!-- /wp:heading -->`;
  const listBlock = (items) => {
    const listItems = items.map(t => `<!-- wp:list-item -->\n<li>${t}</li>\n<!-- /wp:list-item -->`).join('\n');
    return `<!-- wp:list -->\n<ul class="wp-block-list">\n${listItems}\n</ul>\n<!-- /wp:list -->`;
  };
  const separatorBlock = () => `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;

  function splitParagraphs(text) {
    if (!text) return [];
    let parts = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      parts = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    }
    if (parts.length < 3 && parts.join(' ').length > 100) {
      const fullText = parts.join(' ');
      const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
      if (sentences.length >= 3) {
        const chunkSize = Math.ceil(sentences.length / 3);
        parts = [];
        for (let i = 0; i < sentences.length; i += chunkSize) {
          parts.push(sentences.slice(i, i + chunkSize).join(' ').trim());
        }
      } else if (sentences.length === 2) {
        parts = sentences.map(s => s.trim());
      }
    }
    return parts.filter(Boolean);
  }
  const introParagraphs = splitParagraphs(intro);
  const conclusionParagraphs = splitParagraphs(conclusion);

  const defaultTemplate = [
    { type: 'jump-to-recipe' },
    { type: 'paragraphs', from: 0, count: 2, fontSize: '18px', lineHeight: '1.85', spacing: '20px' },
    { type: 'spacer', height: '20px' },
    { type: 'hero' },
    { type: 'spacer', height: '20px' },
    { type: 'paragraphs', from: 2, count: 2, fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'why_this_works', fallback: 'Why This Recipe Works', level: 2 },
    { type: 'why-this-works', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'ingredients', fallback: 'Ingredients', level: 2 },
    { type: 'ingredients-image' },
    { type: 'spacer', height: '15px' },
    { type: 'ingredients-list', fontSize: '18px' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'instructions', fallback: 'Instructions', level: 2 },
    { type: 'steps', showTip: true, fontSize: '18px', lineHeight: '1.85', imageSpacing: '20px' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'tips', fallback: 'Pro Tips', level: 2 },
    { type: 'tips', fontSize: '18px' },
    { type: 'spacer', height: '25px' },
    { type: 'heading', textKey: 'substitutions', fallback: 'Substitutions & Variations', level: 2 },
    { type: 'substitutions', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'storage', fallback: 'Storage Instructions', level: 2 },
    { type: 'storage', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    { type: 'recipe-card' },
    { type: 'spacer', height: '30px' },
    { type: 'heading', textKey: 'faq', fallback: 'Frequently Asked Questions', level: 2 },
    { type: 'faq', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '25px' },
    { type: 'heading', textKey: 'conclusion', fallback: 'Final Thoughts', level: 2 },
    { type: 'note', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '20px' },
    { type: 'fun-fact', fontSize: '18px', lineHeight: '1.85' }
  ];

  const template = settings.postTemplate || defaultTemplate;

  for (const block of template) {
    switch (block.type) {
      case 'jump-to-recipe':
        blocks.push(`<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons"><!-- wp:button {"className":"jump-to-recipe-btn"} -->
<div class="wp-block-button jump-to-recipe-btn"><a class="wp-block-button__link wp-element-button" href="#recipe">Jump to Recipe</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->`);
        break;
      case 'intro':
        blocks.push(...introParagraphs.map(p => pBlock(p)));
        break;
      case 'hero':
        if (existingImages.hero?.wpImageUrl) {
          blocks.push(imgBlock(existingImages.hero.wpImageUrl, recipe?.hero_seo?.alt_text || existingImages.hero.alt || recipe?.post_title || '', existingImages.hero.wpImageId));
        }
        break;
      case 'paragraphs': {
        const from = block.from || 0;
        const count = block.count || 999;
        const slice = introParagraphs.slice(from, from + count);
        const opts = {
          fontSize: block.fontSize, lineHeight: block.lineHeight, align: block.align,
          bold: block.bold, italic: block.italic, dropCap: block.dropCap,
          textColor: block.textColor, bgColor: block.bgColor
        };
        const spacing = block.spacing || '';
        slice.forEach((p, i) => {
          blocks.push(pBlock(p, i === 0 ? opts : { ...opts, dropCap: false }));
          if (spacing && i < slice.length - 1) {
            blocks.push(`<!-- wp:spacer {"height":"${spacing}"} -->\n<div style="height:${spacing}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
          }
        });
        break;
      }
      case 'heading': {
        const level = block.level || 2;
        const text = block.textKey
          ? (sectionTitles[block.textKey] || block.fallback || '')
          : (block.text || '');
        if (!text) break;
        if (level === 2) blocks.push(h2Block(text));
        else if (level === 3) blocks.push(h3Block(text));
        else blocks.push(`<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${esc(text)}</h${level}>\n<!-- /wp:heading -->`);
        break;
      }
      case 'ingredients-image':
        if (existingImages.ingredients?.wpImageUrl) {
          blocks.push(imgBlock(existingImages.ingredients.wpImageUrl, recipe?.ingredients_seo?.alt_text || existingImages.ingredients.alt || 'Ingredients', existingImages.ingredients.wpImageId));
        }
        break;
      case 'ingredients-list':
        if (ingredients.length) {
          blocks.push(listBlock(ingredients.map(i => {
            if (typeof i === 'string') return i;
            const name = i.name || '';
            const desc = i.description || '';
            return desc ? `<strong>${esc(name)}</strong>: ${esc(desc)}` : `<strong>${esc(name)}</strong>`;
          })));
        }
        break;
      case 'steps': {
        const stepOpts = { fontSize: block.fontSize, lineHeight: block.lineHeight };
        const recipeSteps = recipe?.steps || [];
        recipeSteps.forEach((step, i) => {
          const stepTitle = step.title || `Step ${i + 1}`;
          blocks.push(h3Block(`Step ${i + 1}: ${stepTitle}`));
          const img = existingImages.steps[i];
          if (img?.wpImageUrl) {
            blocks.push(imgBlock(img.wpImageUrl, step.seo?.alt_text || img.alt || step.title, img.wpImageId));
            const sp = block.imageSpacing || '20px';
            blocks.push(`<!-- wp:spacer {"height":"${sp}"} -->\n<div style="height:${sp}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
          }
          if (step.description) {
            blocks.push(pBlock(richText(sanitizeAIText(step.description)), { ...stepOpts, raw: true }));
          }
          if (block.showTip !== false && step.tip) {
            blocks.push(pBlock(`<strong>Tip:</strong> ${richText(sanitizeAIText(step.tip))}`, { ...stepOpts, raw: true }));
          }
        });
        break;
      }
      case 'tips': {
        const tips = recipe?.pro_tips || recipe?.tips || [];
        if (tips.length) blocks.push(listBlock(tips.map(sanitizeAIText)));
        break;
      }
      case 'storage': {
        const storage = recipe?.storage_notes || recipe?.storage || '';
        const storeOpts = { fontSize: block.fontSize, lineHeight: block.lineHeight };
        if (storage) blocks.push(pBlock(sanitizeAIText(storage), storeOpts));
        break;
      }
      case 'why-this-works': {
        const txt = recipe?.why_this_works || '';
        if (txt) {
          const opts = { fontSize: block.fontSize, lineHeight: block.lineHeight };
          blocks.push(pBlock(sanitizeAIText(txt), opts));
        }
        break;
      }
      case 'substitutions': {
        const subs = recipe?.substitutions || [];
        if (Array.isArray(subs) && subs.length > 0) {
          const items = subs
            .filter(s => s && (s.ingredient || s.swap))
            .map(s => {
              const ing = esc(s.ingredient || '');
              const swap = esc(s.swap || '');
              const note = s.note ? ' — ' + esc(s.note) : '';
              return `<li><strong>${ing}:</strong> ${swap}${note}</li>`;
            })
            .join('');
          if (items) {
            blocks.push(`<!-- wp:list -->\n<ul class="wp-block-list">${items}</ul>\n<!-- /wp:list -->`);
          }
        }
        break;
      }
      case 'faq': {
        if (recipe?.faq?.length) {
          const faqItems = recipe.faq.map((item, i) => {
            const q = esc(item.question || item.q || '');
            const a = sanitizeAIText(item.answer || item.a || '');
            const id = `faq-question-${Date.now()}-${i}`;
            return { id, jsonQuestion: q, jsonAnswer: a, question: q, answer: a };
          });
          const yoastJson = faqItems.map(f => ({
            id: f.id, question: [f.jsonQuestion], answer: [f.jsonAnswer],
            jsonQuestion: f.jsonQuestion, jsonAnswer: f.jsonAnswer
          }));
          const yoastAttrs = JSON.stringify({ questions: yoastJson });
          let faqInner = '';
          faqItems.forEach(f => {
            faqInner += `<div class="schema-faq-section" id="${f.id}">`;
            faqInner += `<strong class="schema-faq-question">${f.question}</strong>`;
            faqInner += `<p class="schema-faq-answer">${f.answer}</p>`;
            faqInner += `</div>`;
          });
          blocks.push(`<!-- wp:yoast/faq-block ${yoastAttrs} -->\n<div class="schema-faq wp-block-yoast-faq-block">${faqInner}</div>\n<!-- /wp:yoast/faq-block -->`);
        }
        break;
      }
      case 'fun-fact':
        if (recipe?.fun_fact) blocks.push(pBlock(sanitizeAIText(recipe.fun_fact), {
          fontSize: block.fontSize, italic: block.italic, lineHeight: block.lineHeight
        }));
        break;
      case 'recipe-card': {
        if (recipeCardId) {
          blocks.push(`<!-- wp:wp-recipe-maker/recipe {"id":${recipeCardId}} -->\n<div class="wp-block-wp-recipe-maker-recipe">[wprm-recipe id="${recipeCardId}"]</div>\n<!-- /wp:wp-recipe-maker/recipe -->`);
        }
        break;
      }
      case 'note': {
        const noteOpts = { fontSize: block.fontSize, italic: block.italic, lineHeight: block.lineHeight };
        if (conclusion) blocks.push(...conclusionParagraphs.map(p => pBlock(p, noteOpts)));
        break;
      }
      case 'spacer': {
        const height = block.height || '30px';
        blocks.push(`<!-- wp:spacer {"height":"${height}"} -->\n<div style="height:${height}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
        break;
      }
      case 'separator':
        blocks.push(separatorBlock());
        break;
    }
  }

  let html = blocks.filter(Boolean).join('\n\n');

  if (relatedPosts.length > 0) {
    html = autoLinkRelatedRecipes(html, relatedPosts);
  }

  return html;
}

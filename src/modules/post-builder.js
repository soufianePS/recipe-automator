/**
 * Post Builder — builds Gutenberg HTML and publishes WordPress draft
 * Extracted from BaseOrchestrator._stepPublishDraft()
 */

import { sanitizeAIText } from './base-orchestrator.js';
import { Logger } from '../shared/utils/logger.js';

/**
 * Build Gutenberg HTML blocks from recipe data and publish as WordPress draft.
 *
 * @param {object} state       - Current automation state
 * @param {object} settings    - User settings
 * @param {object} WordPressAPI - WordPress API module
 * @param {object} Logger      - Logger instance
 * @returns {{ html: string, draftUrl: string, draftPostId: number }}
 */
export async function buildAndPublishPost(state, settings, WordPressAPI, Logger) {
  Logger.step('WordPress', 'Creating draft post...');

  const recipe = state.recipeJSON;
  const postTitle = recipe?.post_title || state.recipeTitle;
  // Build Gutenberg HTML using section order from settings
  const blocks = [];
  const intro = sanitizeAIText(recipe?.intro || '');
  const conclusion = sanitizeAIText(recipe?.conclusion || '');
  const ingredients = recipe?.ingredients || [];

  const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Convert markdown + allow safe HTML for rich text from ChatGPT
  const richText = t => {
    let s = t || '';
    // Convert markdown bold **text** → <strong>text</strong>
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Convert markdown italic *text* → <em>text</em>
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Convert markdown links [text](url) → <a href="url">text</a>
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Allow existing HTML bold/italic/links (don't escape them)
    // Temporarily protect safe tags
    const safeTags = [];
    s = s.replace(/<(\/?(strong|em|b|i|a|br)\b[^>]*)>/gi, (m, inner) => {
      safeTags.push(m);
      return `__SAFE_${safeTags.length - 1}__`;
    });
    // Escape everything else
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Restore safe tags
    safeTags.forEach((tag, i) => { s = s.replace(`__SAFE_${i}__`, tag); });
    return s;
  };
  const imgBlock = (url, alt, id) => `<!-- wp:image {"id":${id || 0},"sizeSlug":"large","align":"center","linkDestination":"none"} -->\n<figure class="wp-block-image aligncenter size-large"><img src="${url}" alt="${esc(alt)}" class="wp-image-${id || 0}"/></figure>\n<!-- /wp:image -->`;
  const pBlock = (t, opts = {}) => {
    const attrs = {};
    const styles = {};
    if (opts.fontSize) styles.typography = { fontSize: opts.fontSize };
    if (opts.lineHeight) styles.typography = { ...(styles.typography || {}), lineHeight: opts.lineHeight };
    if (opts.textColor) styles.color = { ...(styles.color || {}), text: opts.textColor };
    if (opts.bgColor) styles.color = { ...(styles.color || {}), background: opts.bgColor };
    if (opts.align) attrs.align = opts.align;
    if (opts.dropCap) attrs.dropCap = true;
    if (Object.keys(styles).length) attrs.style = styles;
    const jsonAttrs = Object.keys(attrs).length ? ' ' + JSON.stringify(attrs) : '';
    const cssRules = [
      opts.fontSize ? `font-size:${opts.fontSize}` : '',
      opts.lineHeight ? `line-height:${opts.lineHeight}` : '',
      opts.align ? `text-align:${opts.align}` : '',
      opts.textColor ? `color:${opts.textColor}` : '',
      opts.bgColor ? `background-color:${opts.bgColor};padding:12px` : ''
    ].filter(Boolean).join(';');
    const styleAttr = cssRules ? ` style="${cssRules}"` : '';
    const dropCapClass = opts.dropCap ? ' has-drop-cap' : '';
    let inner = opts.raw ? t : richText(t); // raw = already HTML (e.g. custom-text with esc)
    if (opts.bold) inner = `<strong>${inner}</strong>`;
    if (opts.italic) inner = `<em>${inner}</em>`;
    return `<!-- wp:paragraph${jsonAttrs} -->\n<p${styleAttr}${dropCapClass ? ` class="${dropCapClass.trim()}"` : ''}>${inner}</p>\n<!-- /wp:paragraph -->`;
  };
  const h2Block = t => `<!-- wp:heading -->\n<h2 class="wp-block-heading">${esc(t)}</h2>\n<!-- /wp:heading -->`;
  const h3Block = t => `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${esc(t)}</h3>\n<!-- /wp:heading -->`;
  const listBlock = (items, opts = {}) => {
    const attrs = {};
    const styles = {};
    if (opts.fontSize) styles.typography = { fontSize: opts.fontSize };
    if (opts.textColor) styles.color = { ...(styles.color || {}), text: opts.textColor };
    if (opts.bgColor) styles.color = { ...(styles.color || {}), background: opts.bgColor };
    if (Object.keys(styles).length) attrs.style = styles;
    const jsonAttrs = Object.keys(attrs).length ? ' ' + JSON.stringify(attrs) : '';
    const cssRules = [
      opts.fontSize ? `font-size:${opts.fontSize}` : '',
      opts.textColor ? `color:${opts.textColor}` : '',
      opts.bgColor ? `background-color:${opts.bgColor};padding:12px` : ''
    ].filter(Boolean).join(';');
    const styleAttr = cssRules ? ` style="${cssRules}"` : '';
    const listItems = items.map(t => `<!-- wp:list-item -->\n<li>${t}</li>\n<!-- /wp:list-item -->`).join('\n');
    return `<!-- wp:list${jsonAttrs} -->\n<ul class="wp-block-list"${styleAttr}>\n${listItems}\n</ul>\n<!-- /wp:list -->`;
  };

  // Split intro into paragraphs — matches layout needs
  // Counts how many paragraphs the template needs and splits accordingly
  function splitParagraphs(text) {
    if (!text) return [];
    // Try double newline first
    let parts = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    // If only 1 paragraph, try single newline
    if (parts.length <= 1) {
      parts = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    }
    // If STILL not enough, split by sentences into N chunks
    if (parts.length < 3 && parts.join(' ').length > 100) {
      const fullText = parts.join(' ');
      const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
      if (sentences.length >= 3) {
        // Split into 3 roughly equal parts
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

  const separatorBlock = () => `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;

  // Default template if none configured
  // Clean, readable layout with spacing for ads and easy scrolling
  const defaultTemplate = [
    // Intro
    { type: 'paragraphs', from: 0, count: 2, fontSize: '18px', lineHeight: '1.85', spacing: '20px' },
    { type: 'spacer', height: '20px' },
    { type: 'hero' },
    { type: 'spacer', height: '20px' },
    { type: 'paragraphs', from: 2, count: 2, fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    // Ingredients
    { type: 'heading', text: 'Ingredients', level: 2 },
    { type: 'ingredients-image' },
    { type: 'spacer', height: '15px' },
    { type: 'ingredients-list', fontSize: '18px' },
    { type: 'spacer', height: '30px' },
    // Instructions
    { type: 'heading', text: 'Instructions', level: 2 },
    { type: 'steps', showTip: true, fontSize: '18px', lineHeight: '1.85', imageSpacing: '20px' },
    { type: 'spacer', height: '30px' },
    // Tips
    { type: 'heading', text: 'Pro Tips', level: 2 },
    { type: 'tips', fontSize: '18px' },
    { type: 'spacer', height: '25px' },
    // Storage
    { type: 'heading', text: 'Storage Instructions', level: 2 },
    { type: 'storage', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '30px' },
    // Recipe card
    { type: 'recipe-card' },
    { type: 'spacer', height: '30px' },
    // FAQ
    { type: 'heading', text: 'Frequently Asked Questions', level: 2 },
    { type: 'faq', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '25px' },
    // Conclusion
    { type: 'heading', text: 'Final Thoughts', level: 2 },
    { type: 'note', fontSize: '18px', lineHeight: '1.85' },
    { type: 'spacer', height: '20px' },
    // Fun fact
    { type: 'fun-fact', fontSize: '18px', lineHeight: '1.85' }
  ];

  const template = settings.postTemplate || defaultTemplate;

  // Build blocks from template
  for (const block of template) {
    switch (block.type) {
      case 'intro':
        blocks.push(...introParagraphs.map(p => pBlock(p)));
        break;
      case 'hero':
        if (state.heroImage?.wpImageUrl) {
          blocks.push(imgBlock(state.heroImage.wpImageUrl, recipe?.hero_seo?.alt_text || state.recipeTitle, state.heroImage.wpImageId));
        }
        break;
      case 'paragraphs': {
        const from = block.from || 0;
        const count = block.count || 999;
        const slice = introParagraphs.slice(from, from + count);
        const opts = {};
        if (block.fontSize) opts.fontSize = block.fontSize;
        if (block.bold) opts.bold = true;
        if (block.italic) opts.italic = true;
        if (block.align) opts.align = block.align;
        if (block.textColor) opts.textColor = block.textColor;
        if (block.bgColor) opts.bgColor = block.bgColor;
        if (block.dropCap) opts.dropCap = true;
        if (block.lineHeight) opts.lineHeight = block.lineHeight;
        const spacing = block.spacing || '';
        slice.forEach((p, i) => {
          blocks.push(pBlock(p, i === 0 && opts.dropCap ? opts : { ...opts, dropCap: false }));
          // Add spacer between paragraphs (not after the last one)
          if (spacing && i < slice.length - 1) {
            blocks.push(`<!-- wp:spacer {"height":"${spacing}"} -->\n<div style="height:${spacing}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
          }
        });
        break;
      }
      case 'heading': {
        const level = block.level || 2;
        const text = block.text || '';
        if (level === 2) blocks.push(h2Block(text));
        else if (level === 3) blocks.push(h3Block(text));
        else blocks.push(`<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${esc(text)}</h${level}>\n<!-- /wp:heading -->`);
        break;
      }
      case 'ingredients-image':
        if (state.ingredientsImage?.wpImageUrl) {
          blocks.push(imgBlock(state.ingredientsImage.wpImageUrl, recipe?.ingredients_seo?.alt_text || 'Ingredients', state.ingredientsImage.wpImageId));
        }
        break;
      case 'ingredients-list':
        if (ingredients.length) {
          // Bold name + description (measurements in WPRM schema)
          blocks.push(listBlock(ingredients.map(i => {
            if (typeof i === 'string') return i;
            const name = i.name || '';
            const desc = i.description || '';
            return desc ? `<strong>${esc(name)}</strong>: ${esc(desc)}` : `<strong>${esc(name)}</strong>`;
          })));
        }
        break;
      case 'steps': {
        const stepOpts = { fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor, lineHeight: block.lineHeight };
        state.steps.forEach((step, i) => {
          // Step heading with "Step X:" prefix
          const stepTitle = step.title || `Step ${i + 1}`;
          blocks.push(h3Block(`Step ${i + 1}: ${stepTitle}`));
          blocks.push('');
          // Step image (separate block)
          if (step.wpImageUrl) {
            blocks.push(imgBlock(step.wpImageUrl, step.seo?.alt_text || step.title, step.wpImageId));
            // Break line between image and description
            const stepImgSpacing = block.imageSpacing || settings.stepImageSpacing || '42px';
            blocks.push(`<!-- wp:spacer {"height":"${stepImgSpacing}"} -->\n<div style="height:${stepImgSpacing}" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`);
            blocks.push('');
          }
          // Step description (separate block)
          if (step.description) {
            blocks.push(pBlock(richText(sanitizeAIText(step.description)), { ...stepOpts, raw: true }));
            blocks.push('');
          }
          // Step tip (separate block)
          if (block.showTip !== false && step.tip) {
            blocks.push(pBlock(`<strong>Tip:</strong> ${richText(sanitizeAIText(step.tip))}`, { ...stepOpts, raw: true }));
            blocks.push('');
          }
        });
        break;
      }
      case 'tips': {
        const tips = recipe?.pro_tips || recipe?.tips || [];
        const tipOpts = { fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor };
        if (tips.length) blocks.push(listBlock(tips.map(sanitizeAIText), tipOpts));
        if (recipe?.variations?.length) blocks.push(listBlock(recipe.variations.map(sanitizeAIText), tipOpts));
        break;
      }
      case 'storage': {
        const storage = recipe?.storage_notes || recipe?.storage || '';
        const storeOpts = { fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor, lineHeight: block.lineHeight, italic: block.italic };
        if (storage) blocks.push(pBlock(sanitizeAIText(storage), storeOpts));
        if (recipe?.serving_suggestions) blocks.push(pBlock(sanitizeAIText(recipe.serving_suggestions), storeOpts));
        if (recipe?.make_ahead) blocks.push(pBlock(sanitizeAIText(recipe.make_ahead), storeOpts));
        break;
      }
      case 'faq': {
        if (recipe?.faq?.length) {
          // Use Yoast FAQ block for proper schema markup and SEO
          const faqItems = recipe.faq.map((item, i) => {
            const q = esc(item.question || item.q || '');
            const a = sanitizeAIText(item.answer || item.a || '');
            const id = `faq-question-${Date.now()}-${i}`;
            return { id, jsonQuestion: q, jsonAnswer: a, question: q, answer: a };
          });
          const yoastJson = faqItems.map(f => ({
            id: f.id,
            question: [f.jsonQuestion],
            answer: [f.jsonAnswer],
            jsonQuestion: f.jsonQuestion,
            jsonAnswer: f.jsonAnswer
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
      case 'equipment': {
        const eqOpts = { fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor };
        if (recipe?.equipment?.length) {
          blocks.push(listBlock(recipe.equipment.map(e => {
            if (typeof e === 'string') return `<strong>${esc(e)}</strong>`;
            const name = e.name || '';
            const desc = e.description || e.notes || '';
            return desc ? `<strong>${esc(name)}</strong>: ${esc(desc)}` : `<strong>${esc(name)}</strong>`;
          }), eqOpts));
        }
        break;
      }
      case 'fun-fact':
        if (recipe?.fun_fact) blocks.push(pBlock(sanitizeAIText(recipe.fun_fact), {
          fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor,
          italic: block.italic, lineHeight: block.lineHeight, align: block.align
        }));
        break;
      case 'recipe-card':
        // Placeholder — replaced after recipe card is created
        blocks.push('__RECIPE_CARD_PLACEHOLDER__');
        break;
      case 'note': {
        const noteOpts = { fontSize: block.fontSize, textColor: block.textColor, bgColor: block.bgColor, italic: block.italic, lineHeight: block.lineHeight, align: block.align };
        if (conclusion) blocks.push(...conclusionParagraphs.map(p => pBlock(p, noteOpts)));
        break;
      }
      case 'custom-text': {
        const text = block.text || '';
        if (text) {
          blocks.push(pBlock(esc(text), { raw: true,
            fontSize: block.fontSize || '',
            bold: block.bold || false,
            italic: block.italic || false,
            align: block.align || '',
            textColor: block.textColor || '',
            bgColor: block.bgColor || '',
            dropCap: block.dropCap || false,
            lineHeight: block.lineHeight || ''
          }));
        }
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

  // Fetch WP display name for author attribution
  const wpDisplayName = await WordPressAPI.fetchDisplayName(settings);

  // Recipe Card Plugin — create card and get the block HTML
  const cardPlugin = (settings.recipeCardPlugin || 'wprm').toLowerCase();
  let recipeCardId = 0;
  let recipeCardBlock = '';

  if (cardPlugin === 'wprm' || (cardPlugin !== 'tasty-recipes' && cardPlugin !== 'none' && settings.wprmEnabled)) {
    try {
      const wprmResult = await WordPressAPI.createWPRMRecipe(settings, recipe, state);
      recipeCardId = wprmResult.id;
      Logger.success(`WPRM recipe created (ID: ${recipeCardId})`);
      recipeCardBlock = `<!-- wp:wp-recipe-maker/recipe {"id":${recipeCardId}} -->\n<div class="wp-block-wp-recipe-maker-recipe">[wprm-recipe id="${recipeCardId}"]</div>\n<!-- /wp:wp-recipe-maker/recipe -->`;
    } catch (e) {
      Logger.warn('WPRM creation failed:', e.message);
    }
  } else if (cardPlugin === 'tasty-recipes') {
    try {
      const tastyResult = await createTastyRecipe(settings, recipe, state, wpDisplayName);
      recipeCardId = tastyResult.recipe_id;
      Logger.success(`Tasty Recipe created (ID: ${recipeCardId})`);
      recipeCardBlock = tastyResult.block;
    } catch (e) {
      Logger.error('Tasty Recipes creation failed:', e.message);
    }
  }

  // Replace recipe card placeholder with actual card block
  let html = blocks.map(b => b === '__RECIPE_CARD_PLACEHOLDER__' ? recipeCardBlock : b).filter(Boolean).join('\n\n');

  // Recipe Schema JSON-LD — only add if NO recipe card plugin handles schema
  // WPRM and Tasty Recipes both output their own Recipe schema, so skip to avoid duplicates
  if (!recipeCardId) {
    const schema = {
      '@context': 'https://schema.org/', '@type': 'Recipe',
      name: postTitle,
      description: recipe?.recipe_card_description || recipe?.meta_description || intro,
      image: state.heroImage?.wpImageUrl ? [state.heroImage.wpImageUrl] : [],
      author: { '@type': 'Person', name: wpDisplayName },
      prepTime: recipe?.prep_time || 'PT15M',
      cookTime: recipe?.cook_time || 'PT30M',
      totalTime: recipe?.total_time || 'PT45M',
      recipeYield: String(recipe?.servings || '4'),
      recipeCategory: recipe?.category || 'Main Course',
      recipeIngredient: ingredients.map(i => typeof i === 'string' ? i : `${i.quantity} ${i.name}`),
      recipeInstructions: state.steps.map(s => ({ '@type': 'HowToStep', name: s.title, text: s.description || s.title, ...(s.wpImageUrl ? { image: s.wpImageUrl } : {}) }))
    };
    if (recipe?.cuisine) schema.recipeCuisine = recipe.cuisine;
    if (recipe?.focus_keyword) schema.keywords = recipe.focus_keyword;
    html += `\n\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>\n<!-- /wp:html -->`;
  }

  const post = await WordPressAPI.createDraftPost(
    settings, postTitle, html, state.heroImage?.wpImageId || 0,
    { metaTitle: recipe?.meta_title || '', metaDescription: recipe?.meta_description || '', focusKeyword: recipe?.focus_keyword || '', slug: recipe?.slug || '' },
    recipe?.category || ''
  );

  if (recipeCardId && cardPlugin === 'wprm') {
    try { await WordPressAPI.linkWPRMToPost(settings, recipeCardId, post.id); } catch {}
  }

  // Save pinterest_pins data for social automator
  if (recipe?.pinterest_pins?.length) {
    try {
      const { writeFileSync } = await import('fs');
      const { join } = await import('path');
      const socialDir = join(process.cwd(), 'data', 'pinterest-data');
      const { mkdirSync, existsSync: ex } = await import('fs');
      if (!ex(socialDir)) mkdirSync(socialDir, { recursive: true });
      writeFileSync(join(socialDir, `post-${post.id}.json`), JSON.stringify({
        postId: post.id,
        title: postTitle,
        slug: recipe?.slug || '',
        link: post.editLink?.replace('/wp-admin/post.php?post=', '/?p=')?.replace('&action=edit', '') || '',
        categories: recipe?.category ? [recipe.category] : [],
        pinterestPins: recipe.pinterest_pins
      }, null, 2));
    } catch {}
  }

  return { html, draftUrl: post.editLink, draftPostId: post.id, recipeCardId };
}

/**
 * Create a Tasty Recipe via the custom PHP endpoint
 */
async function createTastyRecipe(settings, recipe, state, wpDisplayName) {
  const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Build ingredients HTML: <ul><li>quantity ingredient</li></ul>
  const ingredients = recipe.ingredients || [];
  const ingredientsHtml = '<ul>' + ingredients.map(i => {
    const qty = i.quantity ? `${i.quantity} ` : '';
    return `<li>${qty}${esc(i.name)}${i.notes ? ` (${esc(i.notes)})` : ''}</li>`;
  }).join('') + '</ul>';

  // Build instructions HTML: <ol><li>step text</li></ol>
  const steps = state.steps || recipe.steps || [];
  const instructionsHtml = '<ol>' + steps.map(s => {
    return `<li>${esc(s.description || s.title || '')}</li>`;
  }).join('') + '</ol>';

  // Build notes from tips + storage
  const notes = [];
  if (recipe.pro_tips?.length) {
    notes.push('<strong>Pro Tips:</strong>');
    notes.push('<ul>' + recipe.pro_tips.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>');
  }
  if (recipe.storage_notes) notes.push(`<strong>Storage:</strong> ${esc(recipe.storage_notes)}`);
  const notesHtml = notes.join('<br>');

  // Build description (recipe_card_description or fallback to first paragraph)
  const cardDesc = recipe.recipe_card_description || '';
  const introText = recipe.intro || '';
  const firstPara = cardDesc || introText.split(/\n\n|\n/)[0] || introText.substring(0, 200);

  // Convert PT format to human-readable (PT30M → "30 minutes", PT1H15M → "1 hour 15 minutes")
  const ptToHuman = (pt) => {
    if (!pt || !pt.startsWith('PT')) return pt || '';
    const h = pt.match(/(\d+)H/)?.[1];
    const m = pt.match(/(\d+)M/)?.[1];
    const parts = [];
    if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
    return parts.join(' ') || pt;
  };

  const body = {
    title: recipe.post_title || state.recipeTitle || 'Untitled Recipe',
    description: firstPara,
    ingredients: ingredientsHtml,
    instructions: instructionsHtml,
    notes: notesHtml,
    prep_time: ptToHuman(recipe.prep_time),
    cook_time: ptToHuman(recipe.cook_time),
    total_time: ptToHuman(recipe.total_time),
    yield: recipe.servings ? `${recipe.servings} servings` : '',
    category: recipe.category || '',
    cuisine: recipe.cuisine || '',
    method: recipe.method || recipe.cooking_method || '',
    diet: recipe.diet || '',
    keywords: recipe.focus_keyword || '',
    image_id: state.heroImage?.wpImageId || 0,
    author_name: wpDisplayName,
    // Nutrition
    serving_size: recipe.nutrition?.serving_size || '1 serving',
    calories: recipe.nutrition?.calories || '',
    protein: recipe.nutrition?.protein || '',
    fat: recipe.nutrition?.fat || '',
    saturated_fat: recipe.nutrition?.saturated_fat || '',
    unsaturated_fat: recipe.nutrition?.unsaturated_fat || '',
    trans_fat: recipe.nutrition?.trans_fat || '',
    carbohydrates: recipe.nutrition?.carbohydrates || '',
    fiber: recipe.nutrition?.fiber || '',
    sugar: recipe.nutrition?.sugar || '',
    sodium: recipe.nutrition?.sodium || '',
    cholesterol: recipe.nutrition?.cholesterol || ''
  };

  const url = `${settings.wpUrl}/wp-json/tasty-recipes/v1/create`;
  const auth = Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64');

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tasty Recipes API error ${resp.status}: ${text}`);
  }

  return await resp.json();
}

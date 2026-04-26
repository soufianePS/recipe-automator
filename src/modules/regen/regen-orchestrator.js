/**
 * Regen Orchestrator — POLISH-in-place rewrite of existing posts.
 *
 * Key idea: do NOT generate a new recipe from scratch. The old post's
 * step images already exist on WordPress, each one shows a specific action.
 * If we replaced the recipe wholesale, the new step descriptions would not
 * match what each image shows. Instead, we:
 *
 *   1. Parse the existing post into a structured object — title, intro,
 *      step titles + image alts + OLD descriptions, ingredients, tips, FAQ,
 *      storage, conclusion, the WPRM card id.
 *   2. Send that structured object to ChatGPT with a POLISH prompt that:
 *        - Keeps every step title and image meaning identical
 *        - Rewrites each step description with tested-recipe signals
 *          (specific temp + time + technique + sensory cue + fail-mode,
 *           occasional first-person "I tried" note)
 *        - Rewrites intro / pro tips / FAQ / storage / conclusion in the
 *          same human voice (banned phrases out, missing apostrophes fixed)
 *        - Generates from scratch the new sections that didn't exist on
 *          the old post (why_this_works, substitutions, fun_fact)
 *   3. Render the new HTML via regen-renderer with the SAME images at the
 *      same positions and the SAME WPRM card id.
 *   4. PUT update on WP — only `content`, `slug`, and Yoast meta change.
 *
 * Untouched: the post id, URL, status (draft/publish), comments, featured
 * image, the WPRM recipe card itself, and every uploaded image.
 *
 * Independent of the VG orchestrator: this never touches VG state, never
 * runs Flow, and never modifies VG behavior.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Logger } from '../../shared/utils/logger.js';
import { StateManager } from '../../shared/utils/state-manager.js';
import { WordPressAPI } from '../../shared/utils/wordpress-api.js';
import { ChatGPTPage } from '../../shared/pages/chatgpt.js';
import { GeminiChatPage } from '../../shared/pages/gemini-chat.js';
import { sanitizeRecipeJSON } from '../base-orchestrator.js';
import { renderRegenHTML } from './regen-renderer.js';

export class RegenOrchestrator {
  constructor(_unused, browserContext, ctx) {
    this.context = browserContext;
    this.ctx = ctx;
    this.chatgpt = new ChatGPTPage(null, browserContext);
    this._gemini = null;
    this.paused = false;
    this._stopRequested = false;
  }

  async pause() {
    this.paused = true;
    Logger.info('[Regen] Pause requested — will stop after current row finishes');
  }

  async start() {
    const settings = await StateManager.getSettings();
    const state = await StateManager.getState();
    const { regenQueue = [], regenDryRun = false } = state;

    if (!regenQueue.length) {
      Logger.warn('[Regen] No post IDs in queue — nothing to do');
      return;
    }

    Logger.info(`[Regen] Starting: ${regenQueue.length} post(s) ${regenDryRun ? '(DRY-RUN)' : '(LIVE — will update WP)'}`);

    const results = [];
    for (let i = 0; i < regenQueue.length; i++) {
      if (this.paused || this._stopRequested) {
        Logger.warn('[Regen] Stopped by request');
        break;
      }
      const postId = regenQueue[i];
      Logger.step('Regen', `${i + 1}/${regenQueue.length}: post ${postId}`);
      try {
        const result = await this._regenOne(postId, settings, regenDryRun);
        results.push({ postId, ok: true, ...result });
        Logger.success(`[Regen] post ${postId} ${regenDryRun ? 'rendered (dry)' : 'updated'} — ${result.editLink || result.dryFile}`);
      } catch (err) {
        Logger.error(`[Regen] post ${postId} failed: ${err.message}`);
        results.push({ postId, ok: false, error: err.message });
      }
    }

    Logger.success(`[Regen] === DONE === ${results.filter(r => r.ok).length}/${results.length} succeeded`);
    for (const r of results) {
      if (r.ok) Logger.info(`  ✓ ${r.postId} — ${r.editLink || r.dryFile}`);
      else Logger.info(`  ✗ ${r.postId} — ${r.error}`);
    }

    await StateManager.updateState({
      regenResults: results,
      regenFinishedAt: Date.now()
    });
  }

  async _regenOne(postId, settings, dryRun) {
    // 1. Fetch existing post + extract images
    const existing = await WordPressAPI.fetchPostForRegen(settings, postId);
    if (!existing.title) throw new Error(`post ${postId} has no title`);
    if (existing.images.length === 0) throw new Error(`post ${postId} has no <img> tags — cannot map images`);

    Logger.info(`[Regen] "${existing.title}" — ${existing.images.length} images, recipe-card-id=${existing.recipeCardId}, status=${existing.status}`);

    // 2. Parse the existing post body into a structured "old recipe" shape.
    const parsed = parseExistingPost(existing.rawContent, existing.images);
    parsed.title = existing.title;
    Logger.info(`[Regen] parsed: ${parsed.steps.length} steps, ${parsed.ingredients.length} ingredients, ${parsed.faq.length} FAQs`);

    // 3. Related-recipes block for internal linking (best-effort)
    let relatedPosts = [];
    let relatedBlock = 'No related recipes available — skip internal linking.';
    try {
      relatedPosts = await WordPressAPI.listPostsFromAllCategories(settings, 3);
      relatedPosts = relatedPosts.filter(p => p.url && !p.url.includes(`p=${postId}`));
      if (relatedPosts.length > 0) {
        relatedBlock = relatedPosts
          .map((p, i) => `${i + 1}. [${p.category || ''}] "${p.title}" — ${p.url}`)
          .join('\n');
      }
    } catch (e) {
      Logger.warn(`[Regen] related-recipes fetch failed: ${e.message}`);
    }

    // 4. Build the polish prompt
    const sectionTitles = randomSectionTitles();
    const prompt = buildPolishPrompt(parsed, relatedBlock, sectionTitles);
    Logger.info(`[Regen] polish prompt: ${prompt.length} chars, ${parsed.steps.length} step descriptions to rewrite`);

    // 5. Send to AI
    const vgSettings = settings.verifiedGenerator || {};
    const aiProvider = vgSettings.aiProvider || settings.aiProvider || 'chatgpt';
    const useGemini = aiProvider === 'gemini';
    let aiChat;
    if (useGemini) {
      if (!this._gemini) this._gemini = new GeminiChatPage(null, this.context);
      await this._gemini.init();
      aiChat = this._gemini;
    } else {
      const gptUrl = vgSettings.chatGptUrl || settings.generatorGptUrl || null;
      const isCustomGpt = gptUrl && !gptUrl.match(/^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/?$/);
      await this.chatgpt.init(isCustomGpt ? gptUrl : null);
      aiChat = this.chatgpt;
    }

    const response = await aiChat.sendPromptAndGetResponse(prompt, true);
    if (!response.success) throw new Error(`AI call failed: ${response.error}`);

    let polished = response.data?.recipe || response.data;
    if (!polished || !Array.isArray(polished.steps)) {
      throw new Error('AI response missing recipe.steps');
    }

    // 6. Force step titles + image alignment to match the OLD post exactly.
    // The polish prompt asks the AI to keep titles unchanged, but we enforce
    // it here so a single image stays glued to the same step description.
    if (polished.steps.length !== parsed.steps.length) {
      Logger.warn(`[Regen] step count mismatch: old=${parsed.steps.length}, new=${polished.steps.length} — truncating to old length`);
      polished.steps = polished.steps.slice(0, parsed.steps.length);
      while (polished.steps.length < parsed.steps.length) {
        polished.steps.push({ title: parsed.steps[polished.steps.length].title, description: '', tip: '' });
      }
    }
    polished.steps.forEach((step, i) => {
      step.number = i + 1;
      // Lock the title to the original — image is glued to it
      step.title = parsed.steps[i].title;
    });

    // Pass through ingredients exactly (they come from the WPRM card / old body)
    if (!Array.isArray(polished.ingredients) || polished.ingredients.length === 0) {
      polished.ingredients = parsed.ingredients;
    }

    polished = sanitizeRecipeJSON(polished);

    // 7. Map images: hero (1st), ingredients (2nd), then step images in order
    const mapped = mapExistingImages(existing.images, parsed.steps.length);
    Logger.info(`[Regen] image map: hero=${!!mapped.hero}, ingredients=${!!mapped.ingredients}, steps=${mapped.steps.filter(Boolean).length}/${parsed.steps.length}`);

    // 8. Render new HTML
    const html = renderRegenHTML({
      recipe: polished,
      existingImages: mapped,
      sectionTitles,
      recipeCardId: existing.recipeCardId,
      settings,
      relatedPosts
    });

    if (dryRun) {
      const outDir = join(process.cwd(), 'output', 'regen');
      await mkdir(outDir, { recursive: true });
      const file = join(outDir, `post-${postId}.html`);
      await writeFile(file, html, 'utf8');
      const jsonFile = join(outDir, `post-${postId}-recipe.json`);
      await writeFile(jsonFile, JSON.stringify(polished, null, 2), 'utf8');
      const parsedFile = join(outDir, `post-${postId}-parsed.json`);
      await writeFile(parsedFile, JSON.stringify(parsed, null, 2), 'utf8');
      return { dryFile: file };
    }

    // 9. PUT update on WordPress (preserve title, status, comments, recipe card)
    const updated = await WordPressAPI.updateDraftPost(settings, postId, {
      content: html,
      slug: polished.slug || existing.slug,
      meta: {
        ...(polished.meta_title && { _yoast_wpseo_title: polished.meta_title }),
        ...(polished.meta_description && { _yoast_wpseo_metadesc: polished.meta_description }),
        ...(polished.focus_keyword && { _yoast_wpseo_focuskw: polished.focus_keyword }),
        ...(polished.meta_title && { _yoast_wpseo_opengraph_title: polished.meta_title }),
        ...(polished.meta_description && { _yoast_wpseo_opengraph_description: polished.meta_description }),
      }
    });

    return { editLink: updated.editLink, link: updated.link };
  }
}

// ─────────────────────────────────────────────────────────────
// Parser — extract structured content from existing post HTML
// ─────────────────────────────────────────────────────────────

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseExistingPost(rawHtml, images) {
  // Pull H3 step blocks: each block is the chunk between an H3 "Step N: <title>"
  // and the next H2 / H3 / recipe-card.
  const stepBlocks = [];
  const stepRe = /<h3[^>]*>\s*Step\s*(\d+)\s*[:\-—–]?\s*([^<]+?)\s*<\/h3>([\s\S]*?)(?=<h[23]|<!-- wp:wp-recipe-maker|\[wprm-recipe|$)/gi;
  let m;
  while ((m = stepRe.exec(rawHtml))) {
    const num = Number(m[1]);
    const title = stripHtml(m[2]);
    const body = m[3];
    // Strip <figure> blocks (image), keep prose
    const prose = body.replace(/<figure[^>]*>[\s\S]*?<\/figure>/g, ' ');
    // Pull tip vs description: tip usually starts with "Tip:" or has <strong>Tip</strong>
    const tipMatch = prose.match(/<strong>\s*Tip:?\s*<\/strong>\s*([\s\S]*?)(?=<\/p>|<p|$)/i);
    const tip = tipMatch ? stripHtml(tipMatch[1]) : '';
    // Description = first paragraph(s) before the tip
    const beforeTip = tipMatch ? prose.slice(0, tipMatch.index) : prose;
    const description = stripHtml(beforeTip);
    stepBlocks.push({ number: num, title, description, tip });
  }

  // Intro: paragraphs before the first <h2> (excluding figures, jump-to-recipe)
  const beforeFirstH2 = rawHtml.split(/<h2/i)[0] || '';
  const introParas = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(beforeFirstH2))) {
    const text = stripHtml(pm[1]);
    if (text && text.length > 10) introParas.push(text);
  }
  const intro = introParas.join('\n\n');

  // Ingredients: <li> items inside the H2 "Ingredients" section
  const ingredients = extractListAfterH2(rawHtml, /Ingredients?\b/i, 50)
    .map(li => parseIngredientLine(stripHtml(li)));

  // Pro Tips: list items
  const proTips = extractListAfterH2(rawHtml, /Pro Tips|Tips and Tricks|Helpful Tips|My Best Tips/i, 20)
    .map(stripHtml).filter(Boolean);

  // Storage
  const storage = extractParagraphAfterH2(rawHtml, /Storage|How to Store/i);

  // Conclusion
  const conclusion = extractParagraphAfterH2(rawHtml, /Final Thoughts|A Final Note|Wrap Up/i);

  // FAQ — Yoast block has schema-faq-section divs
  const faq = [];
  const faqRe = /<strong[^>]*class="schema-faq-question"[^>]*>([\s\S]*?)<\/strong>\s*<p[^>]*class="schema-faq-answer"[^>]*>([\s\S]*?)<\/p>/gi;
  let fm;
  while ((fm = faqRe.exec(rawHtml))) {
    faq.push({ question: stripHtml(fm[1]), answer: stripHtml(fm[2]) });
  }
  // Fallback: simple Q/A pattern in plain HTML
  if (faq.length === 0) {
    const qaRe = /<(?:strong|h[34])[^>]*>\s*([^<]*\?\s*)<\/(?:strong|h[34])>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
    let qm;
    while ((qm = qaRe.exec(rawHtml))) {
      faq.push({ question: stripHtml(qm[1]), answer: stripHtml(qm[2]) });
    }
  }

  // Steps: pair parsed step blocks with image alts (same order)
  // Filter out hero (image[0]) and ingredients (image[1]) — step images start at index 2
  const stepImages = images.slice(2, 2 + stepBlocks.length);
  const steps = stepBlocks.map((s, i) => ({
    ...s,
    image_alt: stepImages[i]?.alt || ''
  }));

  return {
    intro,
    ingredients,
    steps,
    proTips,
    storage,
    conclusion,
    faq
  };
}

function extractListAfterH2(rawHtml, headerRe, maxItems = 50) {
  // Find the H2 matching headerRe, then grab <li> items until next H2
  const h2s = [...rawHtml.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  for (let i = 0; i < h2s.length; i++) {
    const heading = stripHtml(h2s[i][1]);
    if (headerRe.test(heading)) {
      const start = h2s[i].index + h2s[i][0].length;
      const end = h2s[i + 1]?.index ?? rawHtml.length;
      const slice = rawHtml.slice(start, end);
      const items = [...slice.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
      return items.slice(0, maxItems);
    }
  }
  return [];
}

function extractParagraphAfterH2(rawHtml, headerRe) {
  const h2s = [...rawHtml.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  for (let i = 0; i < h2s.length; i++) {
    const heading = stripHtml(h2s[i][1]);
    if (headerRe.test(heading)) {
      const start = h2s[i].index + h2s[i][0].length;
      const end = h2s[i + 1]?.index ?? rawHtml.length;
      const slice = rawHtml.slice(start, end);
      const paras = [...slice.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripHtml(m[1])).filter(Boolean);
      return paras.join('\n\n');
    }
  }
  return '';
}

function parseIngredientLine(line) {
  // Try "<strong>name</strong>: description" first, fall back to plain text
  // Note: stripHtml has already removed the strong tags so we get plain "Name: desc".
  const m = line.match(/^([^:]+):\s*(.+)$/);
  if (m) return { name: m[1].trim(), quantity: '', description: m[2].trim() };
  return { name: line.trim(), quantity: '', description: '' };
}

// ─────────────────────────────────────────────────────────────
// Image mapping
// ─────────────────────────────────────────────────────────────

function mapExistingImages(images, stepCount) {
  // Filter out resized variants — keep originals only
  const fullSize = images.filter(img => !/-\d+x\d+\.(jpg|jpeg|png|webp)/i.test(img.wpImageUrl));
  const list = fullSize.length >= 2 ? fullSize : images;
  const hero = list[0];
  const ingredients = list[1];
  const steps = [];
  for (let i = 0; i < stepCount; i++) steps.push(list[2 + i] || null);
  return { hero, ingredients, steps };
}

// ─────────────────────────────────────────────────────────────
// Polish prompt
// ─────────────────────────────────────────────────────────────

function buildPolishPrompt(parsed, relatedBlock, sectionTitles) {
  const stepsForPrompt = parsed.steps.map((s, i) => ({
    number: i + 1,
    title: s.title,
    image_shows: s.image_alt || '(no alt — describes step ' + s.title + ')',
    old_description: s.description,
    old_tip: s.tip
  }));

  return `You are POLISHING an existing food blog post that has already been published. The post's images, step titles, and the recipe card itself are LOCKED — they cannot change. Your job is to rewrite the prose in a more authentic, tested-recipe voice WITHOUT breaking the alignment between each step's image and its description.

ABSOLUTE RULES:
1. The "title" of each step MUST stay exactly as I provide it. The image attached to that step shows that title's action — DO NOT change the title or the action.
2. Each rewritten step description MUST describe the SAME action shown in the existing image (provided as image_shows). DO NOT introduce new techniques or steps that the image cannot show.
3. The ingredients list MUST stay the same set of items (you may rewrite the description field to be more precise).
4. The recipe card is locked — do NOT output recipe-card content.
5. Output JSON only, matching the schema at the bottom.

PUNCTUATION & VOICE RULES (critical for anti-AI-detection):
- NEVER use semicolons.
- USE contractions: don't, can't, you'll, it's, I've, won't.
- Mix sentence lengths: some short (5-7 words), most medium, occasionally long. Never uniform.
- Occasional sentence fragments are welcome.
- Start some sentences with "And", "But", "So".
- BANNED phrases (do not appear ANYWHERE): "easy to prepare and make", "trust me on this", "I honestly haven't really shared", "elevate", "delve", "culinary journey", "comes together quickly", "mouthwatering", "flavor profile", "taste buds", "without further ado", "let's dive in".

STEP DESCRIPTION RULE — TESTED-RECIPE SIGNALS (CRITICAL):
- Each rewritten step description MUST be 2-3 short paragraphs (not one wall of text).
- EVERY step description MUST include ALL of these where they apply to that step:
  1. SPECIFIC TEMPERATURE — exact number ("375°F", "medium-low about 4 on a 10-dial", "350°F preheated oven").
  2. SPECIFIC TIME — exact range ("8 to 10 minutes", "exactly 90 seconds per side", "until minute 12").
  3. SPECIFIC TECHNIQUE — actual hand-motion ("fold with a J-shaped motion", "swirl the pan once at minute 3", "scrape the bowl down halfway").
  4. ONE CONCRETE SENSORY CUE — what the cook sees, hears, or smells ("the edges turn deep golden", "you'll smell the garlic ready", "sauce coats the back of a spoon").
  5. WHAT GOES WRONG IF YOU MISS THE WINDOW — short clause ("past 12 minutes the bottom scorches", "miss this and the sauce breaks").
- For roughly 1 step in every 4-5, include ONE first-person testing note inside the description (in parentheses, its own sentence). Example: "(I used to mash it smooth, but the toast always felt flat. A few chunks make it better.)".
- The description must still match what the existing image shows (image_shows field).
- The "tip" field is for an ADDITIONAL practical tip — never duplicate content from the description.

INTRO RULE:
- Rewrite the existing intro into 3 short paragraphs separated by \\n\\n.
- Real human voice, not "These [Recipe Name] feature a creamy mash..." templated AI opener.
- Keep the same overall meaning (this dish is X, you'd serve it for Y).
- Include 1 internal link from {{related_recipes}} naturally in paragraph 2 or 3.

NEW SECTIONS TO GENERATE FROM SCRATCH (the old post lacked these — high-value SEO sections):
- why_this_works: 2-3 sentences mentioning a specific technique, ingredient interaction, temperature, or timing trick that non-cooks would not know. Concrete, not vague.
- substitutions: 4-6 entries covering dietary needs (dairy-free, gluten-free) + availability swaps. Each entry: { ingredient, swap, note (honest — say if it changes the result) }. Include 1 internal link in one note.
- fun_fact: 1 sentence. Not "lava cake became famous for..." style trivia. Pick something concrete and specific to this dish.
- recipe_card_description: 450-480 chars summary including words: easy, quick, simple, best, healthy, ideas; mention an event (weeknight dinner, meal prep, brunch, holiday).
- meta_title, meta_description (under 155 chars), focus_keyword, slug.

EXISTING CONTENT TO POLISH:
==========================
TITLE: ${parsed.title || ''}

INTRO (rewrite into 3 paragraphs, real voice, one internal link):
---
${parsed.intro || '(no existing intro — create one based on the recipe topic)'}
---

INGREDIENTS (keep same items, you may improve the description field):
${JSON.stringify(parsed.ingredients, null, 2)}

STEPS (these are LOCKED — keep titles and image meaning, rewrite descriptions only):
${JSON.stringify(stepsForPrompt, null, 2)}

PRO TIPS (rewrite each one — keep the same advice but in tighter human voice):
${JSON.stringify(parsed.proTips, null, 2)}

STORAGE (rewrite — same advice, better voice):
${parsed.storage || '(no existing storage section — write 1-2 short paragraphs about fridge/freezer time + reheating)'}

FAQ (rewrite each answer; you may add 1-2 new Q/A if the existing list is short):
${JSON.stringify(parsed.faq, null, 2)}

CONCLUSION (rewrite — 2-3 sentences, friendly close, one internal link):
${parsed.conclusion || '(no existing conclusion — write one)'}

RELATED RECIPES (use these for internal links — exact titles + URLs):
${relatedBlock}

OUTPUT THIS EXACT JSON SHAPE (no markdown, no code fences):
{
  "recipe": {
    "post_title": "${parsed.title || ''}",
    "slug": "url-slug",
    "focus_keyword": "main keyword",
    "meta_title": "SEO title under 60 chars",
    "meta_description": "SEO desc under 155 chars",
    "recipe_card_description": "450-480 chars",
    "intro": "3 paragraphs separated by \\\\n\\\\n",
    "why_this_works": "2-3 sentences with a specific technique or temp",
    "ingredients": [
      { "name": "...", "quantity": "", "description": "..." }
    ],
    "steps": [
      { "number": 1, "title": "<KEEP EXACTLY AS PROVIDED>", "description": "2-3 short paragraphs with temp + time + technique + sensory cue + fail-mode", "tip": "additional practical tip — must NOT duplicate description" }
    ],
    "pro_tips": ["short polished tip", "..."],
    "substitutions": [
      { "ingredient": "...", "swap": "...", "note": "honest note about how the result changes" }
    ],
    "storage_notes": "1-2 short paragraphs",
    "faq": [{ "question": "?", "answer": "2-3 sentences" }],
    "conclusion": "2-3 sentences",
    "fun_fact": "1 specific concrete sentence"
  }
}

CRITICAL OUTPUT RULES:
- Output ONLY valid JSON, no markdown, no code fences, no explanations.
- The "steps" array MUST have exactly ${parsed.steps.length} entries with the titles I provided, in the same order.
- Every prose field must follow the punctuation & voice rules above.
- ABSOLUTELY NO em dashes inside descriptions (em dashes are only allowed inside parenthetical first-person testing notes).`;
}

// ─────────────────────────────────────────────────────────────

function randomSectionTitles() {
  const pool = {
    why_this_works: ['Why This Recipe Works', 'The Secret to This Recipe', 'What Makes This Recipe Work', 'Why You Will Love This'],
    ingredients: ['Ingredients', 'Ingredient List', 'What You Will Need', 'Ingredients You Will Need'],
    instructions: ['How to Make It', 'Instructions', 'Method', 'Step by Step'],
    tips: ['Pro Tips', 'Tips and Tricks', 'My Best Tips', 'Helpful Tips'],
    substitutions: ['Substitutions & Variations', 'Make It Your Own', 'Swaps and Variations'],
    storage: ['Storage Instructions', 'How to Store', 'Storing Leftovers'],
    faq: ['Frequently Asked Questions', 'Common Questions', 'Questions I Get Asked'],
    conclusion: ['Final Thoughts', 'A Final Note', 'Wrap Up']
  };
  const out = {};
  for (const [k, opts] of Object.entries(pool)) {
    out[k] = opts[Math.floor(Math.random() * opts.length)];
  }
  return out;
}

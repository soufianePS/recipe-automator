/**
 * Prompt Builder — converts structured visual state into prose prompts for Flow.
 *
 * Format: narrative prose (per Google's official Imagen/Nano Banana guidance).
 * Subject + action + setting first. Composition and identity middle. Positive
 * style anchors next. Only proven negatives at the end ("no text, no watermark,
 * no logo"). All other "no X" phrasing converted to positive descriptions, since
 * the model tends to latch onto nouns after "no".
 */

import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

function joinList(items, opts = {}) {
  const arr = (items || []).filter(Boolean);
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  const sep = opts.sep || ', ';
  const finalSep = opts.finalSep || ' and ';
  return arr.slice(0, -1).join(sep) + finalSep + arr[arr.length - 1];
}

function describeIngredient(ing) {
  if (typeof ing === 'string') return ing;
  let s = ing.name;
  if (ing.state) s += ` (${ing.state})`;
  if (ing.placement) s += ` ${ing.placement}`;
  return s;
}

function describeIngredientLine(item) {
  let s = `- ${item.name}`;
  if (item.state) s += ` — ${item.state}`;
  if (item.presentation) s += `, ${item.presentation}`;
  if (item.brand) s += ` with the brand label "${item.brand}" visible on the package`;
  if (item.placement) s += ` (${item.placement})`;
  return s;
}

function buildCanonSentence(canon, stageHint = '') {
  if (!canon || !canon.primary_food) return '';
  const features = (canon.hallmark_features || []).filter(Boolean);
  let s = `The food in this image is "${canon.primary_food}". Its silhouette: ${canon.silhouette}.`;
  if (canon.size) s += ` Size: ${canon.size}.`;
  if (features.length > 0) s += ` Hallmark features that should be clearly visible: ${joinList(features, { sep: ', ', finalSep: ', and ' })}.`;
  if (stageHint) {
    s += ` Color at this stage: ${stageHint}.`;
  } else if (canon.color_progression) {
    s += ` Color progression across the recipe: ${canon.color_progression}.`;
  }
  s += ` The silhouette must stay consistent with every other step image of this recipe.`;
  return s;
}

// Reference-roles paragraph. CRITICAL: in Flow the BACKGROUND/surface image is
// always attached FIRST (reference #1), then these context refs follow in order.
// So the background must be counted as (1) and the context refs numbered from (2)
// — otherwise Flow maps role (1) onto the background and every role is shifted by
// one (refs not respected). The LAST attached reference is the strongest signal
// in Flow, so it is flagged explicitly.
function buildRefRolesParagraph(refRoles) {
  if (!Array.isArray(refRoles) || refRoles.length === 0) return '';
  const total = refRoles.length + 1;                                  // +1 = background, attached first
  const numbered = refRoles.map((role, i) => `(${i + 2}) ${role}`);   // context refs start at (2)
  const lastNote = refRoles.length >= 1
    ? ` Reference (${total}) — the LAST attached image — is the single most important one to match closely.`
    : '';
  return `${total} reference images are attached, in this exact order from first to last attached: (1) the background/surface reference described above — use it ONLY for the counter surface and window lighting, never for the food; ${numbered.join('; ')}.${lastNote} Look at every attached reference and match it closely; use each strictly for its stated purpose and do not blend the roles.`;
}

// Explicit continuity header for follow-up images in the SAME Flow chat.
// The new Flow remembers the conversation, so we tell it to keep the previous
// image's scene and only change what the step requires.
function buildStepContinuitySentence(container) {
  const c = container || 'container';
  return `Continuity: this is the NEXT image in the same recipe, generated right after the previous image in this same chat. Keep the SAME kitchen — same marble counter, same window lighting — and the SAME food identity, colors and texture as the previous image, so it reads as the same cooking session continuing. Use the ${c} for this step: if it is the same vessel as the previous image keep it identical; if this step moves the food to a different vessel (a pan, a wire rack, a plate), show that new vessel naturally. Change only what the step below describes.`;
}

function buildHeroContinuitySentence() {
  return `Continuity: this hero shot is generated right after the final cooking step in the same chat. It shows the SAME finished dish as the previous image — same food identity, same colors, same kitchen surface and window light — just presented as the most beautiful final shot, possibly from a slightly different angle.`;
}

function buildCompositionSentence(comp) {
  if (!comp || typeof comp !== 'object') return '';
  const parts = [];
  if (comp.subject_placement) parts.push(`The main subject sits ${comp.subject_placement}.`);
  if (comp.subject_orientation) parts.push(`It is oriented: ${comp.subject_orientation}.`);
  if (comp.depth) parts.push(`Depth: ${comp.depth}.`);
  if (Array.isArray(comp.secondary_elements) && comp.secondary_elements.length > 0) {
    const els = comp.secondary_elements
      .filter(e => e && (e.what || e.where))
      .map(e => {
        let s = e.what || '';
        if (e.where) s += ` ${e.where}`;
        if (e.count) s += ` (${e.count})`;
        return s.trim();
      })
      .filter(Boolean);
    if (els.length > 0) {
      parts.push(`Other visible elements: ${joinList(els, { sep: '; ', finalSep: '; and ' })}.`);
    }
  }
  if (comp.negative_space) parts.push(`The surface around the subject is ${comp.negative_space}.`);
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// 1. STEP PROMPT (used for every recipe step + the serving step)
// ─────────────────────────────────────────────────────────────────────

// Appetite-appeal paragraph for the serving shot + hero — makes the dish look
// irresistibly delicious with tempting, mouth-watering close-up detail.
function buildAppetiteAppealParagraph() {
  return `Appetite appeal: make this look irresistibly delicious and mouth-watering — the kind of photo that instantly makes the viewer hungry and want to taste it. Let the finished dish fill the frame generously so its tempting small details read clearly: gentle wisps of steam rising from the warm food, glossy sauce glistening as it catches the light, a luscious cheese pull or melt where it applies, a juicy tender interior, crispy golden edges, caramelized and seared surfaces, tiny glistening droplets of moisture, fresh herb flecks, and rich saturated color. Capture fine texture up close — the crumb, the sear, the sheen, the flake — so the food looks freshly served, warm, generous, and utterly crave-worthy.`;
}

export function buildStepPrompt(stepState, vgSettings, opts = {}) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const isServingStep = opts.isLastStep || false;
  const canon = opts.foodIdentityCanon || null;
  const container = stepState.container || defaults.defaultContainer;
  const camera = stepState.camera_angle || defaults.defaultCameraAngle;
  const foodState = stepState.food_state || '';
  const positionPhrase = stepState.position || stepState.arrangement || '';
  const ingredientsList = (stepState.visible_ingredients || []).map(describeIngredient).filter(Boolean);
  const visibleProse = ingredientsList.length > 0
    ? `Inside the ${container}: ${joinList(ingredientsList, { sep: ', ', finalSep: ', and ' })}.`
    : '';

  const canonStageColor = canon?.color_progression ? '' : '';
  const canonSentence = buildCanonSentence(canon, canonStageColor);
  const compositionSentence = buildCompositionSentence(stepState.composition);

  // ── 1. Opening: subject + action + setting (front-loaded) ──
  const opening = isServingStep
    ? `Photorealistic food photography — the serving shot of a finished dish. Natural homemade iPhone-style kitchen photo, not a commercial studio shot.`
    : `Photorealistic food photography — natural homemade iPhone-style kitchen photo, not a commercial studio shot.`;

  // ── 1b. Continuity header — only for follow-up steps (the chat remembers
  //        the previous image; step 1 establishes the scene instead). ──
  const continuityPara = opts.firstStep ? '' : buildStepContinuitySentence(container);

  // ── 2. Main scene paragraph ──
  const mainScene = [
    `The scene shows ${container} on a marble counter, captured from a ${camera} angle under soft natural daylight from a kitchen window.`,
    foodState ? `Food state right now: ${foodState}` : '',
    visibleProse,
    positionPhrase ? `Position and movement from the previous step: ${positionPhrase}` : ''
  ].filter(Boolean).join(' ');

  // ── 3. Identity anchor (if canon) ──
  const identityPara = canonSentence;

  // ── 4. Composition direction ──
  const compositionPara = compositionSentence
    ? `Composition: ${compositionSentence} The marble surface around the ${container} is completely bare — only the ${container} sits on the counter.`
    : `Composition: the ${container} is centered slightly off-axis in the frame. The marble surface around it is completely bare — only the ${container} sits on the counter.`;

  // ── 5. Style anchors (all positive, no "NO X") ──
  let stylePara = `Style: warm rich colors with golden-brown for cooked items, vibrant greens for vegetables, glossy sauces. Sharp focus with visible texture — grain in rice, fibers in meat, bubbles in sauce, flakes in pastry. Food looks three-dimensional with depth and volume, moist and fresh. Casual home-cooked look with natural imperfections — asymmetric placement, slight unevenness, no sterile symmetry.`;

  // Serving shot gets a dedicated appetite-appeal paragraph (see return chain).
  const appetitePara = isServingStep ? buildAppetiteAppealParagraph() : '';

  if (opts.firstStep) {
    stylePara += ` This is the FIRST cooking step — clearly a process shot showing active cooking (food in the pan or pot, mid-transformation), not a still-life of raw ingredients on a counter.`;
  }

  // ── 6. Background and lighting anchor (reference image) ──
  const referencePara = `Background and lighting come from the uploaded reference image: preserve its marble surface exactly — same color, same veining, same grain, same texture, same edges. Match the reference lighting precisely: same direction, same softness, same warmth, same shadow length. The scene should look like the same counter on the same day, lit by the same window.`;

  // ── 7. Reference image roles (explicit per-ref purpose — critical when 3+ refs are attached) ──
  const refRolesPara = buildRefRolesParagraph(opts.refRoles);

  // ── 8. Critical constraints (only proven-effective negatives) ──
  const criticalPara = `Critical: only the ${container} sits on the marble counter — the surface around it is completely bare, with no stray berries, herbs, crumbs, droplets, slices, or scattered ingredients of any kind on the surface. All food is inside the ${container}. No text, no watermark, no logo.`;

  return [opening, continuityPara, mainScene, identityPara, compositionPara, stylePara, appetitePara, referencePara, refRolesPara, criticalPara]
    .filter(Boolean)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────
// 2. INGREDIENTS FLAT-LAY PROMPT
// ─────────────────────────────────────────────────────────────────────

export function buildIngredientsPrompt(ingredientsState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const camera = ingredientsState.camera_angle || defaults.defaultCameraAngle;
  const items = ingredientsState.items || [];
  const layoutHint = ingredientsState.layout || '';

  // ── 1. Opening ──
  const opening = `Photorealistic raw-ingredients flat-lay photo for a food blog. Natural editorial style, soft natural daylight from a window. This is the only image in the recipe where ingredients sit directly on the surface — items are spread across the frame to show what the cook is about to use.`;

  // ── 2. Frame and background ──
  const framePara = `The entire frame is filled with the uploaded reference surface (marble, wood, or linen). Preserve that surface exactly — its grain, color, stripes, texture, edges, and any minor flaws. The reference fills 100% of the frame edge to edge, with no white borders or blank space.`;

  // ── 3. Items as prose bulleted list ──
  const itemsHeader = `Items visible across the surface:`;
  const itemsLines = items.map(describeIngredientLine).join('\n');

  // ── 4. Layout ──
  const layoutPara = `Layout: items are placed organically with asymmetric spacing — some clustered, some with gaps, none perfectly aligned, and they reach near all four edges of the frame to fill the composition. Heights vary: tall standing bottles and boxes alongside flat bowls and whole produce. Sizes vary: a few large plates or wooden boards for the star ingredients, a small number of ceramic ramekins (2–4 maximum) for finely chopped herbs, spices, grated cheese, or pre-diced items. Everything else stays in its whole, packaged, or plated form. ${layoutHint}`.trim();

  // ── 5. Container rule (forceful — keeps loose/small items off the bare surface) ──
  const containerPara = `Container rule (VERY IMPORTANT): every loose, granular, powdered, chopped, grated, or small ingredient MUST sit inside its OWN small white ceramic bowl, ramekin, or clear glass — never loose or scattered on the surface. This includes salt, sugar, flour, baking soda and baking powder, all spices, chopped or minced herbs, grated cheese, seeds, nuts, oats, and small loose fruit such as berries, blueberries, raspberries, or grapes (a small handful goes in a bowl, not on the counter). ONLY naturally self-contained items may rest directly on the surface: whole uncut produce (a whole apple, banana, lemon, onion, tomato, or a few whole eggs in their shells) and sealed store packaging (bottles, jars, boxes, bags, cans, butter blocks). When unsure, put the ingredient in a small bowl.`;

  // ── 6. Packaging rule ──
  const packagingPara = `Packaging: every ingredient that comes in a store package (oil bottles, spice shakers, flour bags, sugar boxes, sauce jars, canned goods, butter blocks, cream cheese bricks) shows a realistic, readable brand label printed directly on the physical package — invent believable fake brand names like "Heath Riles BBQ", "GRAZA Oil", or "Great Value Flour". Scooped or loose ingredients in bowls (sour cream, shredded cheese, chopped herbs, salt, sugar, berries) sit in plain white or ceramic bowls with no label, no sticker, and no brand stamp.`;

  // ── 6. Style anchors ──
  const stylePara = `Camera angle: ${camera}. Style: authentic home-kitchen food-blog aesthetic, warm tones, sharp focus, raw uncooked ingredients only. Lighting matches the reference image — soft diffused daylight from one side, gentle ambient fill, natural shadow length.`;

  // ── 7. Critical constraints (positive where possible) ──
  const criticalPara = `Critical: ingredients are raw and uncooked, never mixed together. No utensils, no cutting boards as separate items (the surface itself is the background). No text overlays, no watermark, no logo — the only text visible is the brand labels printed on actual packaging.`;

  return [opening, framePara, itemsHeader + '\n' + itemsLines, layoutPara, containerPara, packagingPara, stylePara, criticalPara]
    .filter(Boolean)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────
// 3. HERO PROMPT
// ─────────────────────────────────────────────────────────────────────

export function buildHeroPrompt(heroState, vgSettings, opts = {}) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const canon = opts.foodIdentityCanon || null;
  const container = heroState.container || defaults.defaultContainer;
  const camera = heroState.camera_angle || '45-degree angle';
  const description = heroState.base_description || 'the finished dish';
  const arrangement = heroState.arrangement || 'appetizing final presentation, casually plated like a careful home cook would';
  const allowed = (heroState.allowed_additions || []).filter(Boolean);
  const canonSentence = buildCanonSentence(canon, 'fully cooked, finished and glazed to its final color');
  const compositionSentence = buildCompositionSentence(heroState.composition);

  // ── 1. Opening: hero declaration + subject ──
  const opening = `Photorealistic food photography — the hero shot of the finished recipe. Natural homemade style on a real home kitchen counter, not a commercial studio shoot. This is the most beautiful, magazine-cover-worthy photo of the entire recipe.`;

  // ── 1b. Continuity header — the hero follows the last step in the same chat. ──
  const continuityPara = buildHeroContinuitySentence();

  // ── 2. Scene paragraph ──
  const mainScene = `The scene shows ${description} in ${container}, captured from a ${camera} angle on a marble counter under soft natural daylight from a kitchen window. ${arrangement}.`;

  // ── 3. Identity anchor ──
  const identityPara = canonSentence;

  // ── 4. Composition ──
  const compositionPara = compositionSentence
    ? `Composition: ${compositionSentence}`
    : '';

  // ── 5. Allowed garnish ──
  const garnishPara = allowed.length > 0
    ? `Allowed garnish on the plate: ${joinList(allowed, { sep: ', ', finalSep: ', and ' })}. Garnish sits on the plate or directly next to the food on the plate.`
    : '';

  // ── 6. Style anchors (positive) ──
  const stylePara = `Style: warm rich colors — golden-brown seared surfaces, deep rich sauces, bright fresh herbs. Sharp focus with visible texture: crispy edges, glossy sauce, melted cheese, caramelized surfaces, visible grain and fiber. Three-dimensional depth and volume — sauce pools naturally, toppings sit generously, nothing flat or sparse. Moisture is visible: sauce glistens, meat looks juicy, vegetables look fresh and crisp. The food is fully cooked, the dish is finished, and the image alone should make a reader want to cook this recipe. Slight imperfections that look home-cooked, never sterile or symmetric.`;

  // ── 6b. Appetite appeal — make it look the most delicious of all ──
  const appetitePara = buildAppetiteAppealParagraph();

  // ── 7. Reference image anchor ──
  const referencePara = `Background and lighting come from the uploaded reference image: preserve its marble surface exactly — same color, same veining, same grain, same texture, same edges. Match the reference lighting precisely: same direction, same softness, same warmth, same shadow shape. The hero looks like the same counter on the same day with the same window light.`;

  // ── Reference image roles (explicit per-ref purpose) ──
  const refRolesPara = buildRefRolesParagraph(opts.refRoles);

  // ── 8. Critical constraints ──
  const criticalPara = `Critical: only the plate or serving dish is on the marble counter — the surface around it is completely bare. All food stays on or inside the plate; any garnish sits on the plate edge or directly next to the food on the plate, never scattered on the bare counter. No raw ingredients are visible, only the finished cooked dish. No text, no watermark, no logo.`;

  return [opening, continuityPara, mainScene, identityPara, compositionPara, garnishPara, stylePara, appetitePara, referencePara, refRolesPara, criticalPara]
    .filter(Boolean)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────
// 4. CORRECTION PROMPT (appended on retry after verifier fails)
// ─────────────────────────────────────────────────────────────────────

export function buildCorrectionPrompt(stepState, verifierResult, vgSettings) {
  const fixes = [];

  if (verifierResult.stray_items_outside_container === true) {
    fixes.push(`The previous image showed food items on the bare counter around the container. Move every food item inside the container. The marble surface around the container must be completely bare — only the container is on it.`);
  }

  if (verifierResult.identity_match === false) {
    const canon = stepState._canon || null;
    if (canon && canon.primary_food) {
      const features = (canon.hallmark_features || []).join(', ');
      fixes.push(`The food in the previous image had the wrong silhouette. It must look unmistakably like "${canon.primary_food}" — silhouette: ${canon.silhouette}. The hallmark features that must be visible: ${features}.`);
    } else {
      fixes.push(`The food in the previous image had the wrong shape. Render the correct silhouette and proportions for this recipe's primary food.`);
    }
  }

  if (verifierResult.composition_match === false) {
    fixes.push(`The placement of the food did not match the composition direction. Re-render with the subject in the correct quadrant of the frame and the correct orientation, with the secondary elements where specified and the surface around the subject empty as described.`);
  }

  if (verifierResult.forbidden_found?.length > 0) {
    for (const item of verifierResult.forbidden_found) {
      fixes.push(`Remove the ${item} from the image — it should not be visible at this step.`);
    }
  }

  if (verifierResult.container_count > 1) {
    fixes.push(`The previous image showed ${verifierResult.container_count} containers. Show only one container.`);
  }

  if (verifierResult.state_match === false && stepState.food_state) {
    fixes.push(`The food state did not match. The current state should be: ${stepState.food_state}.`);
  }

  if (verifierResult.missing_ingredients?.length > 0) {
    for (const item of verifierResult.missing_ingredients) {
      fixes.push(`Add the missing ${item} — it belongs in this step.`);
    }
  }

  if (verifierResult.extra_items?.length > 0) {
    for (const item of verifierResult.extra_items) {
      fixes.push(`Remove the extra ${item} — it does not belong in this step.`);
    }
  }

  const issueText = (verifierResult.issues || []).filter(Boolean).join('. ');

  let body;
  if (fixes.length > 0) {
    body = `Specific corrections required:\n\n` + fixes.map((f, i) => `${i + 1}. ${f}`).join('\n');
  } else {
    body = `Re-render the image, paying closer attention to every detail in the previous prompt.`;
  }

  return `The previous image was rejected by quality control. ${issueText ? 'Issues noted: ' + issueText + '.' : ''}\n\n${body}\n\nAll other rules from the previous prompt still apply.`;
}

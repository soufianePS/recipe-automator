/**
 * Content Quality Gate — checks readability and AI patterns per section.
 * Only re-prompts ChatGPT for sections that fail, not the whole recipe.
 */

import { Logger } from './logger.js';

let textReadability;
let aiTextDetector;

async function loadModules() {
  if (!textReadability) {
    textReadability = (await import('text-readability')).default || await import('text-readability');
  }
  if (!aiTextDetector) {
    const mod = await import('ai-text-detector');
    aiTextDetector = mod.detectAIContent || mod.default?.detectAIContent || mod.default;
  }
}

/**
 * Split recipe content into named sections for individual checking.
 */
function splitIntoSections(recipe) {
  const sections = [];

  if (recipe.intro) {
    sections.push({ name: 'intro', field: 'intro', text: recipe.intro });
  }
  if (recipe.conclusion) {
    sections.push({ name: 'conclusion', field: 'conclusion', text: recipe.conclusion });
  }
  if (recipe.storage_notes) {
    sections.push({ name: 'storage_notes', field: 'storage_notes', text: recipe.storage_notes });
  }
  if (recipe.fun_fact) {
    sections.push({ name: 'fun_fact', field: 'fun_fact', text: recipe.fun_fact });
  }

  // Check step descriptions (combine all steps into one check)
  if (recipe.steps && recipe.steps.length > 0) {
    const stepsText = recipe.steps
      .map(s => typeof s === 'string' ? s : (s.description || s.text || ''))
      .join(' ');
    if (stepsText.length > 50) {
      sections.push({ name: 'steps', field: 'steps', text: stepsText });
    }
  }

  return sections;
}

/**
 * Check a single section for readability and AI patterns.
 * Returns { pass, readabilityScore, aiScore, issues[] }
 */
function checkSection(section, targetReadability = 60) {
  const issues = [];
  let readabilityScore = 70; // default pass
  let aiScore = 0;

  // Skip very short sections
  if (!section.text || section.text.length < 100) {
    return { pass: true, readabilityScore, aiScore, issues };
  }

  // Check readability
  try {
    if (textReadability.fleschReadingEase) {
      readabilityScore = textReadability.fleschReadingEase(section.text);
    } else if (typeof textReadability === 'function') {
      readabilityScore = textReadability(section.text);
    }
    if (readabilityScore < targetReadability) {
      issues.push(`readability too low (${Math.round(readabilityScore)} < ${targetReadability})`);
    }
  } catch (e) {
    Logger.debug(`[Quality] Readability check failed for ${section.name}: ${e.message}`);
  }

  // Check for AI patterns
  try {
    if (typeof aiTextDetector === 'function') {
      const result = aiTextDetector(section.text);
      if (result && typeof result === 'object') {
        aiScore = result.confidence || result.score || 0;
        if (aiScore > 0.7) {
          issues.push(`AI patterns detected (confidence: ${(aiScore * 100).toFixed(0)}%)`);
        }
      }
    }
  } catch (e) {
    Logger.debug(`[Quality] AI detection failed for ${section.name}: ${e.message}`);
  }

  // Manual pattern checks for common AI cliches
  const aiPatterns = [
    /it's worth noting/gi,
    /it is worth noting/gi,
    /delve into/gi,
    /in conclusion/gi,
    /this ensures that/gi,
    /whether you're a .* or a/gi,
    /let's dive in/gi,
    /without further ado/gi,
    /game.?changer/gi,
    /elevate your/gi,
    /take .* to the next level/gi,
  ];

  const patternMatches = [];
  for (const pattern of aiPatterns) {
    const matches = section.text.match(pattern);
    if (matches) {
      patternMatches.push(...matches);
    }
  }
  if (patternMatches.length > 0) {
    issues.push(`AI cliches found: ${patternMatches.slice(0, 3).join(', ')}`);
  }

  // Check for excessive repetition (same phrase 3+ times)
  const words = section.text.toLowerCase().split(/\s+/);
  const threeGrams = {};
  for (let i = 0; i < words.length - 2; i++) {
    const gram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    threeGrams[gram] = (threeGrams[gram] || 0) + 1;
  }
  const repeated = Object.entries(threeGrams)
    .filter(([gram, count]) => count >= 3 && gram.length > 10)
    .map(([gram, count]) => `"${gram}" (${count}x)`);
  if (repeated.length > 0) {
    issues.push(`repetitive phrases: ${repeated.slice(0, 2).join(', ')}`);
  }

  return {
    pass: issues.length === 0,
    readabilityScore: Math.round(readabilityScore),
    aiScore,
    issues
  };
}

/**
 * Build a targeted re-prompt for a single failing section.
 */
function buildFixPrompt(section, issues) {
  return `Rewrite the following text to fix these issues: ${issues.join('; ')}.

Rules:
- Vary sentence length (mix short and long)
- Use contractions naturally (don't, won't, it's)
- Add personal voice and casual tone
- Remove AI cliches and overly formal language
- Keep the same information and meaning
- Keep approximately the same length
- Do NOT add headers, bullet points, or formatting
- Return ONLY the rewritten text, nothing else

Text to rewrite:
${section.text}`;
}

/**
 * Run the content quality gate on a recipe.
 * Checks each section, returns list of sections that need fixing.
 *
 * @param {object} recipe - Recipe JSON from ChatGPT
 * @param {object} settings - User settings with quality options
 * @returns {{ passed: boolean, results: Array, fixPrompts: Array<{field, prompt}> }}
 */
export async function checkContentQuality(recipe, settings = {}) {
  await loadModules();

  const targetReadability = settings.readabilityTarget || 60;
  const sections = splitIntoSections(recipe);
  const results = [];
  const fixPrompts = [];

  for (const section of sections) {
    const result = checkSection(section, targetReadability);
    results.push({
      name: section.name,
      field: section.field,
      ...result
    });

    if (!result.pass) {
      Logger.warn(`[Quality] ${section.name}: FAIL — ${result.issues.join(', ')}`);
      fixPrompts.push({
        field: section.field,
        prompt: buildFixPrompt(section, result.issues),
        issues: result.issues
      });
    } else {
      Logger.debug(`[Quality] ${section.name}: PASS (readability: ${result.readabilityScore})`);
    }
  }

  const passed = fixPrompts.length === 0;
  if (passed) {
    Logger.success(`[Quality] All ${sections.length} sections passed quality check`);
  } else {
    Logger.info(`[Quality] ${fixPrompts.length}/${sections.length} sections need improvement`);
  }

  return { passed, results, fixPrompts };
}

/**
 * Apply fixes to recipe by sending only failed sections to ChatGPT for rewrite.
 *
 * @param {object} recipe - Original recipe JSON
 * @param {Array} fixPrompts - From checkContentQuality()
 * @param {object} chatgpt - ChatGPT page instance
 * @returns {object} Updated recipe with fixed sections
 */
export async function applyContentFixes(recipe, fixPrompts, chatgpt) {
  const updatedRecipe = { ...recipe };

  for (const fix of fixPrompts) {
    try {
      Logger.step('Quality', `Fixing ${fix.field}: ${fix.issues.join(', ')}`);
      const response = await chatgpt.sendPromptAndGetResponse(fix.prompt, false);

      if (response.success && response.data) {
        const fixedText = response.data.trim();
        // Only apply if the fix is reasonable (not empty, not too different in length)
        if (fixedText.length > 50 && fixedText.length < fix.prompt.length * 3) {
          if (fix.field === 'steps') {
            // Steps are special — we can't easily replace individual step descriptions
            // Log the fix but don't apply (too risky to break step structure)
            Logger.info(`[Quality] Steps quality flagged but not auto-fixed (structure sensitive)`);
          } else {
            updatedRecipe[fix.field] = fixedText;
            Logger.success(`[Quality] Fixed ${fix.field} (${fixedText.length} chars)`);
          }
        } else {
          Logger.warn(`[Quality] Fix for ${fix.field} rejected (suspicious length: ${fixedText.length})`);
        }
      }
    } catch (e) {
      Logger.warn(`[Quality] Failed to fix ${fix.field}: ${e.message}`);
    }
  }

  return updatedRecipe;
}

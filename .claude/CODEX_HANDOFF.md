# Codex Handoff - Recent Project Changes

Date: 2026-06-25

This note summarizes the changes Codex made so Claude can quickly understand the current app behavior before editing.

## Project Context

This is a Node/Express + Playwright recipe automation app. It reads pending recipes from Google Sheets, generates recipe content/images, creates WordPress drafts, generates Pinterest pins, uploads media, and writes results back to the sheet.

Active tested site during these changes: `leagueofcooking`.

## Recent Tested Runs

- Row 102, `Chocolate Chip Cookies`, completed successfully.
  - Draft: `https://leagueofcooking.com/wp-admin/post.php?post=5279&action=edit`
  - 3 Pinterest pin images uploaded.
  - Sheet row repaired/marked done after confirming media.
- Row 89, `Christmas Cookies`, completed successfully.
  - Draft: `https://leagueofcooking.com/wp-admin/post.php?post=5309&action=edit`
  - Article has 8 images.
  - 3 Pinterest pin images uploaded.
  - No pending rows remained after the test.

## Important Changes

### 1. One-row start support

`POST /api/start` now accepts:

```json
{
  "mode": "generate",
  "rowIndexes": [89]
}
```

If `rowIndexes` is provided, the batch queue is filtered to those pending rows only. Without `rowIndexes`, behavior stays the same as before: it queues all pending rows.

File:
- `src/routes.js`

### 2. Pinterest template rotation

Pinterest pin templates no longer always start from the first 3 templates. They rotate by recipe.

Example with 7 templates and 3 pins:

- recipe 1 uses templates 1, 2, 3
- recipe 2 uses templates 4, 5, 6
- recipe 3 uses templates 7, 1, 2
- recipe 4 uses templates 3, 4, 5

State is stored in:

```json
"pinterestTemplateRotationIndex": {
  "generator": 0,
  "scraper": 0
}
```

Important: if only 3 templates exist and 3 pins are generated, the index returns to 0 because `(0 + 3) % 3 = 0`. That is expected.

Files:
- `src/modules/verified-generator/orchestrator.js`
- `src/modules/base-orchestrator.js`
- `src/shared/utils/state-manager.js`

### 3. Pinterest reference images reduced from 2 to 1

The verified generator now passes only 1 Pinterest reference photo instead of 2 for:

- first step image
- final step image
- hero image

File:
- `src/modules/verified-generator/orchestrator.js`

### 4. Google Sheet update failure is no longer hidden

Previously, `updateSheet()` could catch a Google Sheet write error and still mark the job completed. That could create a false success where WordPress draft/media existed but the sheet row stayed pending.

Now the sheet update error is thrown, so the run fails visibly instead of silently succeeding.

File:
- `src/modules/save-upload.js`

### 5. Pinterest board validation and category mapping

Board validation was improved to better scrape Pinterest saved boards:

- opens `/<username>/_saved/`
- pre-scrolls to avoid virtualization hiding top boards
- case-insensitive board matching
- cleans names like `Board Name\n55 Pins`

Manual category to board mapping was added in the Planifier UI.

New APIs:

- `GET /api/planifier/board-mapping/:site/:accountId`
- `POST /api/planifier/board-mapping/:site/:accountId`

Executor behavior:

- If `account.categoryBoardMap` has a category mapping, it uses it.
- If no explicit mapping exists, it tries auto-match.
- If a category exists but no board is mapped/matched, it skips instead of choosing a random board.

Files:
- `src/modules/planifier/boards-validator.js`
- `src/modules/planifier/action-executor.js`
- `src/modules/planifier/warming-executor.js`
- `src/modules/planifier/default-config.js`
- `src/dashboard/planifier.js`
- `src/routes.js`

### 6. Manual SEO keywords from Google Sheet column Z

New behavior: the app reads manual focus keywords from Google Sheet column `Z`.

Default setting:

```json
"seoKeywordsColumn": "Z"
```

If column Z is empty, behavior stays like before.

If column Z contains keywords, example:

```text
easy christmas cookies, soft sugar cookies, holiday cookies, christmas dessert ideas, cookie decorating
```

Then those keywords are used in:

- blog SEO fields: `focus_keyword`, `meta_title`, `meta_description`
- image SEO metadata: hero, ingredients, steps
- Pinterest pin titles/descriptions
- Pinterest pin image metadata
- Pinterest hashtags/tags written back to the sheet

Pinterest descriptions are expanded when manual keywords exist:

- target length about 450-650 characters
- 3-5 short sentences
- 5-8 hashtags

Files:
- `src/shared/utils/sheets-api.js`
- `src/shared/utils/state-manager.js`
- `src/modules/verified-generator/orchestrator.js`
- `src/modules/base-orchestrator.js`
- `src/modules/save-upload.js`

## Usage Notes

### Sheet columns

Known generator sheet layout:

- A: topic
- B: status
- C: draft URL / error
- D: timestamp
- E: category
- F-Q: Pinterest pin image URL, description, title, tags for 3 pins
- Z: manual SEO keywords input

Do not move result columns without also updating sheet writing logic.

### Testing one recipe

Use:

```powershell
$body = @{ mode = 'generate'; rowIndexes = @(89) } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:3000/api/start -Method Post -Body $body -ContentType 'application/json'
```

Monitor:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/state
Invoke-RestMethod -Uri http://localhost:3000/api/sites/leagueofcooking/pending-topics
```

### Syntax checks used

Run these after edits:

```powershell
node --check src\routes.js
node --check src\shared\utils\sheets-api.js
node --check src\shared\utils\state-manager.js
node --check src\modules\verified-generator\orchestrator.js
node --check src\modules\base-orchestrator.js
node --check src\modules\save-upload.js
node --check src\modules\planifier\boards-validator.js
node --check src\modules\planifier\action-executor.js
node --check src\modules\planifier\warming-executor.js
```

## Git Notes

Last pushed commit before the SEO column work:

```text
1b2a4de Improve Pinterest board mapping and pin generation flow
```

The manual SEO keyword column work was implemented after that push and may still need commit/push unless already done later.

There may be a local `src/dashboard/dashboard.js` status caused by line endings/touch only. Check `git diff -- src/dashboard/dashboard.js`; if empty, do not include it in commits.

---

# Codex Handoff Update - 2026-06-26

This section records the latest session work so Claude/future agents can continue without rediscovering the same Flow, SEO, and Pinterest issues.

## Current Local State

As of this update, `git status --short` shows local modifications in:

- `src/dashboard/dashboard.js`
- `src/modules/base-orchestrator.js`
- `src/modules/verified-generator/orchestrator.js`
- `src/shared/pages/flow-cleanup.js`
- `src/shared/pages/flow.js`

Do not assume these are all committed. Check `git diff` before editing or pushing.

## Tested Recipe Run

Latest successful verification run:

- Sheet row: `113`
- Site/tab: `leagueofcooking` / `League of cooking Gen`
- Recipe: `Pumpkin Spice Sourdough Bread`
- Focus keyword from column Z: `Fall Sourdough Bread Recipes`
- WordPress draft: `https://leagueofcooking.com/wp-admin/post.php?post=5431&action=edit`
- WPRM recipe ID observed: `5429`
- Result: batch completed successfully.

Keyword verification result for draft `5431`:

- Blog body: keyword present.
- WordPress REST meta: keyword present.
- Media metadata: `7/7` attached media contained keyword in slug/title/alt/caption/description.
- Pinterest descriptions in the sheet: `3/3` contained the keyword.
- Pinterest descriptions were about `650` characters in that test.

## Flow Reference Attachment Fixes

The urgent Flow issue was that refs were not always actually present in the composer before clicking Create.

Files:

- `src/shared/pages/flow.js`
- `src/shared/pages/flow-cleanup.js`

Important behavior now:

- Flow clears the composer, attaches background/context refs first, inserts prompt text after refs, then checks composer readiness before Create.
- `_assertPromptReady(expectedRefs, minPromptLength, label)` verifies both prompt text and reference thumbnails before generation.
- `_getPromptRefs()` was improved to detect thumbnails near the prompt editor instead of relying on fragile viewport position.
- If a background/context ref is required but not attached, generation should fail before Create instead of silently producing an image without refs.
- Prompt text may be compacted before insertion to improve Flow composer reliability.

Observed good logs look like:

```text
[Flow] Prompt compacted for composer reliability: 4412 -> 1770 chars
pre-create composer check: refs=3/3, prompt=1796 chars
pre-create composer check: refs=2/2, prompt=1730 chars
pre-create composer check: refs=4/4, prompt=1798 chars
```

If debugging future Flow failures, check for the `pre-create composer check` line before trusting any generated image.

## Step Reference Policy

User requested this final rule:

- First cooking step must NOT use Pinterest finished-dish refs.
- Pinterest refs are only for the final serving step and hero image.
- Step 1 should use the ingredients image only when available.
- Intermediate steps should use previous step images for continuity.
- Final serving step uses Pinterest finished-dish ref plus previous step images.
- Hero uses Pinterest finished-dish ref plus final serving image.

Current implementation in `src/modules/verified-generator/orchestrator.js`:

- Step 1 sets `pinterestRefs = []` and logs `Refs attached: ... (ingredients only)`.
- Final step still loads `state.vgPinterestRefs`.
- Hero still loads `heroPinterest` from `state.vgPinterestRefs`.

Do not re-add Pinterest refs to step 1 unless the user explicitly reverses this decision.

## Manual SEO Keywords Column Z

Manual keywords from Google Sheet column `Z` are parsed with comma, semicolon, newline, and tab support.

Important helper behavior in `src/modules/verified-generator/orchestrator.js`:

- `parseManualKeywords()` splits on `[,;\n\t]+`.
- `mergeKeywords()` also supports tab/newline-separated pasted lists.
- If column Z is empty, generation should behave like before.
- If column Z has keywords, they are injected into the first recipe/content prompt and enforced again after parsing the AI response.

Placement expectations:

- Blog SEO: `focus_keyword`, `meta_title`, `meta_description`.
- Blog content: intro/conclusion should naturally include keywords.
- Image SEO: hero, ingredients, every step image metadata.
- Pinterest: descriptions, image metadata, hashtags/tags.

## Pinterest Description Rule

The user wants each Pinterest pin description to be long, useful, unique, and SEO-focused.

Current rule:

- Target length: `500-700` characters.
- Must include the focus keyword / manual exact phrases when provided.
- Must include a description specific to the pin, not generic filler only.
- Each of the 3 pins must have its own angle/title/description/image prompt.
- Hashtags stay at the end.

Current safeguard:

- `expandPinterestDescription()` normalizes descriptions after Gemini output.
- It adds a distinct angle per pin:
  - Pin 1: finished look / serving / save-worthy idea.
  - Pin 2: flavor / texture / why to try it.
  - Pin 3: planning / shopping / quick discovery.
- It expands short descriptions until they are around the target range.
- It trims to max `700` characters including hashtags.

Gemini prompt rule was also updated from `450-650` to `500-700`.

## Visual Step Count / Gemini Step Coverage

There was a problem on a friend PC where Gemini produced more recipe steps but Flow/WP only had fewer images/steps.

The orchestrator now logs count checks and synthesizes missing visual steps when needed:

```text
[VerifiedGen] Count check before visual validation: recipe.steps=X, visual_plan.visual_steps=Y, pinterest_pins=Z
[VerifiedGen] Count check after visual validation: recipe.steps=X, visual_plan.visual_steps=N
```

If `visual_plan.visual_steps` is shorter than `recipe.steps`, `ensureVisualStepCoverage()` adds missing visual steps so Flow and WordPress stay complete.

## Internal Link Correction Tool

A Multi Site / Planifier internal-link correction flow was added earlier in this workstream.

Purpose:

- Find internal links in blog content pointing to draft/admin URLs such as `wp-admin/post.php?post=...&action=edit` or `?p=id`.
- Convert/fix them to public permalinks where possible.
- Show progress in a popup and recap corrected links.

Relevant files to inspect:

- `src/modules/planifier/internal-link-auditor.js`
- `src/routes.js`
- `src/dashboard/planifier.js`

If the user cannot find the button, check the Multi Site / Planifier UI rendering and route wiring.

## Pinterest Board Mapping Reminder

Manual category-to-board mapping exists in Planifier.

Expected behavior:

- User can map each site category to a Pinterest board manually.
- Executor should use explicit mapping first.
- If no mapping exists, it may try automatic board name matching.
- If no board can be matched for the category, it should skip instead of choosing a random board.

This avoids posting recipes to unrelated Pinterest boards.

## Quick Checks After Future Edits

Run at least:

```powershell
node --check src\modules\verified-generator\orchestrator.js
node --check src\shared\pages\flow.js
node --check src\shared\pages\flow-cleanup.js
node --check src\modules\base-orchestrator.js
```

For a real Flow validation, watch for:

```text
pre-create composer check: refs=A/B, prompt=N chars
```

For SEO validation after a recipe run, verify:

- Column Z keyword is read.
- Pin descriptions are `500-700` chars.
- Pin descriptions contain the focus keyword.
- WP media metadata contains the keyword.
- Blog body/meta contains the keyword.

---

# Codex Handoff Update - 2026-06-27

Latest fixes pushed after the 2026-06-26 handoff.

## Pushed Commits

- `8c3cb06 Avoid salvaging incomplete Gemini JSON`
- `c345c18 Skip Gemini recipe image refs`
- `87c7122 Use dedicated ChatGPT profile for recipe JSON`
- `00ff60e Respect custom pin prompts and long descriptions`
- `8a7f769 Trim duplicate Flow context refs`

## Gemini Recipe JSON

Gemini recipe generation is now text-only for the large recipe JSON prompt.

Reason:

- Friend's PC showed Gemini UI error `Un problème est survenu (1155)`.
- Logs showed Gemini started streaming JSON but stopped mid-response.
- Old listener accepted the truncated JSON and parser auto-closed it, which produced `recipe` without `visual_plan`.

Current behavior:

- `src/shared/utils/gemini-network-listener.js` no longer accepts incomplete JSON after a short silent stream.
- It waits longer and falls back to DOM extraction instead of handing incomplete JSON to the parser.
- `src/modules/verified-generator/orchestrator.js` skips attaching Pinterest image refs to Gemini recipe JSON prompts.
- Log expected:

```text
[Gemini] Recipe prompt will be text-only; skipping X Pinterest reference image(s)
```

## ChatGPT Recipe JSON Profile

When `Recipe JSON AI = chatgpt`, it now uses the dedicated ChatGPT pin profile, not the Flow account browser context.

Profile source:

- `settings.chatgptPin.profilePath`
- fallback: `data/chatgpt-pin-profile`

Expected logs:

```text
[ChatGPT] launching dedicated recipe/profile context: ...data/chatgpt-pin-profile
[ChatGPT] Recipe JSON response captured; deleting chat from history
[ChatGPT] Dedicated recipe/profile context closed
```

Important:

- Do not keep that Chrome profile open manually while automation runs.
- The app closes the dedicated ChatGPT context before continuing to Flow/pins.

## ChatGPT Pin Prompt Template

Custom ChatGPT pin prompt templates are now respected exactly.

Old behavior:

- If the user's template did not contain `@prompt`, the app appended:

```text
--- PIN-SPECIFIC INSTRUCTIONS ---
...
```

New behavior:

- If `chatgptPin.promptTemplate` is set, the app uses it as-is.
- If it contains `@prompt`, the inner generated prompt is inserted there.
- If it does not contain `@prompt`, nothing extra is appended.
- Placeholders still resolve: `@title`, `@website`, `@pin_title`, `@pin_description`, `@ingredients`, `@aspectRatio`, etc.
- The app still prepends:

```text
Output image format: <aspectRatio>
```

unless aspect ratio is `auto`.

Files:

- `src/modules/base-orchestrator.js`
- `src/modules/planifier/pin-regenerator.js`

## Pinterest Description Length

Bug found on row `116`, recipe `Banana Cream Pie`:

- Pin 1 description: `217` chars
- Pin 2 description: `210` chars
- Pin 3 description: `201` chars

Cause:

- `expandPinterestDescription()` was only reliably applied when manual column Z keywords existed.
- Short AI descriptions could pass through unchanged.

Fix:

- `applyManualSeoKeywords()` now also normalizes Pinterest descriptions when manual keywords are empty.
- Target remains `500-700` chars.
- If column Z has keywords, those are used.
- If column Z is empty, fallback keyword source is `recipe.focus_keyword` or recipe title.

Note:

- Existing Sheet rows already written are not auto-repaired.
- Regenerate/fix pins to update old rows.

## Flow Ref Attachment Test

A real Playwright test was run using the same `FlowPage.generate(...)` method as the recipe pipeline.

Test:

- Step 1: background only.
- Step 2: same background + step 1 image as context ref.

Confirmed logs:

```text
pre-create composer check: refs=1/1, prompt=256 chars
Verified background ref in prompt: ingredients.jpg (0 -> 1)
Verified context ref in prompt: Food prep image white bowl (1 -> 2)
pre-create composer check: refs=2/2, prompt=356 chars
```

Visual result:

- Step 1 generated a bowl with bananas on the black marble background.
- Step 2 reused the same bowl/surface and added flour, proving the previous-step ref was used.

## Flow Duplicate Ref Fix

During the first Flow ref test, fallback upload/picker could add an extra duplicate ref:

```text
pre-create composer check: refs=3/2
```

Fix in `src/shared/pages/flow.js`:

- After context fallback upload, the code recounts prompt refs.
- If one file added more than one ref, extra refs are removed before Create.
- Same fix applied to normal generate and `generateWithReuse`.

Second test confirmed clean:

```text
pre-create composer check: refs=2/2
```

## Pre-Create Check Verification

A no-generation Playwright test confirmed `_assertPromptReady()` works:

- With only background attached but expected refs = 2, it fails:

```text
intentional-missing-context composer check: refs=1/2
expected 2 prompt ref(s), found 1
```

- After attaching context ref, it passes:

```text
after-context-attached composer check: refs=2/2
final check passed: refs=2/2 before Create
```

This means the app should not click `Create` if a required background/context ref is missing from the Flow prompt composer.

## Current Local Note

`src/dashboard/dashboard.js` may still show as modified locally with no useful diff. It has intentionally been left out of commits unless a real diff appears.

---

# Codex Handoff Update - 2026-06-27 Late Session

This update records the verified end-to-end test and fixes made after the prior 2026-06-27 handoff.

## Successful End-to-End Test

Tested row:

- Sheet tab: `League of cooking Gen`
- Row: `115`
- Recipe: `Air Fryer Zucchini Chips`
- AI settings during final successful run:
  - `aiProvider=chatgpt`
  - `pinGenerator=chatgpt`
- WordPress draft: `https://leagueofcooking.com/wp-admin/post.php?post=5510&action=edit`
- Status: Sheet row marked `done`.
- Category written to Sheet: `Lunch`.

Verified results:

- Recipe JSON generated via the dedicated ChatGPT profile.
- ChatGPT cleanup deleted recipe/image chats after use.
- `recipe.steps=5`, `visual_plan.visual_steps=5`, `pinterest_pins=3`.
- 5 step images + hero + ingredients uploaded to WordPress.
- 3 Pinterest pin images generated with ChatGPT and uploaded to WordPress.
- Pinterest template rotation advanced:

```text
[Pinterest] Template rotation generator: 6 -> 9 (3 pin(s), 16 template(s))
```

Sheet pin description lengths:

- Pin 1: `697`
- Pin 2: `694`
- Pin 3: `696`

All are within the requested `500-700` character range.

WordPress post verification for post `5510`:

- Draft exists.
- No `wp-admin`, `post.php`, or raw `?p=ID` admin links were found in normal internal links.
- Internal links point to public permalinks such as `/potato-salad/`, `/lemon-garlic-roast-chicken/`, `/homemade-hot-dogs/`, `/mini-sliders/`, `/chicken-sliders/`.
- All 9 focus keywords from column Z were found in the rendered post content:
  - `Air Fryer Squash With Parmesan`
  - `Crispy Air Fried Zucchini`
  - `Air Fryer Zucchini With Parmesan`
  - `Zucchini In The Air Fryer`
  - `Zucchini Side Dish Recipes Air Fryer`
  - `Fried Zucchini Recipe Easy Air Fryer`
  - `Parmesan Crusted Zucchini In Air Fryer`
  - `Air Fryer Zucchini And Parmesan`
  - `Best Zucchini Recipes Air Fryer`

## Fixes Added In This Session

### 1. Flow Pro limit / no-start fallback

Files:

- `src/shared/pages/flow-download.js`
- `src/shared/pages/flow.js`
- `src/modules/base-orchestrator.js`

Behavior:

- Flow now detects more quota/limit messages, including Nano Banana Pro limit text.
- `_waitForGenerationProgress()` returns `false` if no progress/new image appears after timeout.
- If Nano Banana Pro does not start, Flow raises a rate-limit error instead of screenshotting the background/canvas as the output.
- On the first image, a Pro rate-limit now tries `Nano Banana 2` before rotating accounts.

Expected good log:

```text
[VerifiedGen] Ingredients: 1× failed on Nano Banana Pro — falling back to Nano Banana 2
[Flow] Model switched to "Nano Banana 2"
```

### 2. Gemini truncated JSON no longer accepted

Files:

- `src/shared/utils/parser.js`
- `src/modules/verified-generator/orchestrator.js`

Behavior:

- `Parser.extractJSON()` no longer auto-closes truncated JSON unless explicitly requested.
- If Gemini returns parsed JSON without `visual_plan`, the verified generator asks for one complete JSON retry.
- This prevents partial Gemini output from being accepted as a valid recipe.

### 3. Guaranteed 3 Pinterest pins

File:

- `src/modules/verified-generator/orchestrator.js`

Behavior:

- If the AI returns fewer pins than needed, `ensurePinterestPinCoverage()` synthesizes missing pin plans.
- The 500-700 character description normalizer still runs afterward.

Good log:

```text
[Pinterest] Completed pin plan coverage: 1 -> 3
```

Only appears when the AI returned too few pins.

### 4. WordPress builder accepts object-shaped AI fields

File:

- `src/modules/post-builder.js`

Bug fixed:

```text
Orchestrator error: s.replace is not a function
```

Cause:

- ChatGPT sometimes returns nested objects/arrays in fields that the WordPress builder later escapes with `.replace()`.

Fix:

- `textValue()` converts strings, numbers, booleans, arrays, and common object shapes to text before escaping/rendering.
- The post builder and Tasty/WPRM recipe creator now use `textValue()` in HTML escaping.

### 5. Flow stale ref cleanup is stricter

File:

- `src/shared/pages/flow.js`

Behavior:

- If refs cannot be cleared from the composer, normal generation now closes the session and starts a fresh project before attaching refs.
- If reuse workflow cannot clear refs, it falls back to normal generation in a fresh project.
- `_assertPromptReady()` continues to block Create when too few required refs are present.

Observed during row 115:

```text
pre-create failed: expected 3 prompt ref(s), found 2
Waiting 3s before retry...
New project created
pre-create composer check: refs=3/3
```

This is the intended safety behavior.

## Remaining Issue To Fix Later

Flow can still add a duplicate reference during fallback picker/upload for a single file.

Observed examples:

```text
Context fallback added 2 refs for one file: ingredients.jpg
pre-create composer check: refs=3/2
...
pre-create composer check: refs=4/3
```

This did not block the final row 115 run, and the workflow completed successfully, but it should be corrected later so fallback attachment removes/avoids duplicates more reliably. The previous massive accumulation problem (`refs=20+/expected`) is reduced by fresh-project cleanup, but duplicate fallback refs can still appear in individual generations.

Recommended future fix:

- After each single context fallback attachment, compare `refsAfter - refsBefore`.
- If more than one ref was added, remove the newest extra ref(s) or start a fresh project before Create.
- Make `_removePromptRefByIndex()` more robust for refs whose X button is hard to detect.

## Syntax Checks Run

```powershell
node --check src\shared\pages\flow-download.js
node --check src\shared\pages\flow.js
node --check src\modules\base-orchestrator.js
node --check src\shared\utils\parser.js
node --check src\modules\verified-generator\orchestrator.js
node --check src\modules\post-builder.js
```

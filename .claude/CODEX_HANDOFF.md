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

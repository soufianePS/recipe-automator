# Recipe Automator — Architecture

A practical guide for understanding the codebase, picking the right mode, and making safe changes.

## Table of contents

1. [What the app does](#1-what-the-app-does)
2. [Top-level layout](#2-top-level-layout)
3. [Sites & active site](#3-sites--active-site)
4. [The four pipeline modes](#4-the-four-pipeline-modes)
5. [Recipe lifecycle (state machine)](#5-recipe-lifecycle-state-machine)
6. [Per-mode walkthrough](#6-per-mode-walkthrough)
7. [Browser automation: Playwright + Flow accounts](#7-browser-automation-playwright--flow-accounts)
8. [Google Sheet integration](#8-google-sheet-integration)
9. [WordPress integration](#9-wordpress-integration)
10. [How to make changes safely](#10-how-to-make-changes-safely)
11. [Known gotchas & debugging tips](#11-known-gotchas--debugging-tips)

---

## 1. What the app does

End-to-end content pipeline for food blogs. For each recipe topic in a Google Sheet, it:

1. Reads the topic
2. Generates a structured recipe JSON via an AI (ChatGPT / Gemini / Codex CLI depending on mode)
3. Generates 8–12 images (1 hero, 1 ingredients, N steps, 0–1 serving close-up, 3 Pinterest pins) via Google Flow (`labs.google/flow`) or Gemini chat
4. Uploads images to WordPress
5. Builds the Gutenberg post HTML + Tasty Recipes recipe card
6. Publishes as draft
7. Marks the Sheet row as done

Express dashboard on `localhost:3000` exposes settings, controls, logs.

---

## 2. Top-level layout

```
recipe-automator/
├── src/
│   ├── server.js             # Express bootstrap, browser launch, SIGINT
│   ├── routes.js             # All HTTP routes (/api/start, /api/settings, …)
│   ├── dashboard/            # Static dashboard HTML/CSS/JS
│   ├── modules/
│   │   ├── base-orchestrator.js   # Shared state machine + step handlers
│   │   ├── generator/             # Mode A: topic → ChatGPT/Gemini → Flow
│   │   ├── verified-generator/    # Mode B: VG — Pinterest grounding + image verifier
│   │   ├── gemini-visual/         # Mode C: GV — Gemini chat-based for everything
│   │   ├── scraper/               # Mode D: scrape URL → regenerate
│   │   ├── regen/                 # Existing-post polish/rewrite
│   │   ├── post-builder.js        # Gutenberg block assembly
│   │   ├── save-upload.js         # Disk save + WP upload + Sheet write
│   │   └── …
│   ├── shared/
│   │   ├── pages/                 # Playwright wrappers (one per site)
│   │   │   ├── chatgpt.js
│   │   │   ├── gemini-chat.js
│   │   │   ├── gemini-image-chat.js
│   │   │   └── flow.js            # ⚠ 1700+ lines, biggest file
│   │   └── utils/
│   │       ├── state-manager.js   # State + settings persistence
│   │       ├── logger.js
│   │       ├── sheets-api.js
│   │       ├── wordpress-api.js
│   │       ├── flow-account-manager.js
│   │       ├── gemini-network-listener.js
│   │       ├── watermark-remover.js
│   │       └── parser.js
│   └── scripts/                   # WP setup, one-off maintenance
├── data/                          # Gitignored — runtime state
│   ├── active-site.txt            # Which site is currently selected
│   ├── flow-accounts.json         # Multi-account rotation state
│   ├── sites/<name>/              # Per-site settings + state
│   │   ├── settings.json          # All site settings (incl. secrets)
│   │   ├── state.json             # Live orchestrator state
│   │   ├── history.json
│   │   └── backgrounds.json
│   └── tmp/                       # Scratch (wiped between recipes)
├── output/                        # Generated images per recipe (gitignored)
├── scripts/                       # Standalone test/debug scripts
└── package.json
```

---

## 3. Sites & active site

The app supports multiple WordPress sites. The active one is stored in `data/active-site.txt`. All per-site config lives in `data/sites/<site-name>/settings.json`.

Switching sites: write the new name to `active-site.txt` (the dashboard has a UI for it). Each site has its own:

- Sheet ID + tab name
- WordPress URL + credentials
- Prompt templates
- Image background folder
- Kitchen backgrounds (used as Flow background canvas)
- Pinterest template folders
- Mode-specific settings (verifiedGenerator, geminiVisual, etc.)

---

## 4. The four pipeline modes

Pick the mode that matches what you want to produce. All modes share the same state machine and the same WordPress upload path — the difference is **how the recipe JSON and images are generated**.

| Mode | API param | When to use | JSON gen | Image gen | Cost |
|------|-----------|-------------|----------|-----------|------|
| **generator** | `mode: "generate"` | Default. Quick blog posts. | ChatGPT or Gemini browser | Flow (with backgrounds) | Free (subscription) |
| **VG** (verified) | `mode: "verified"` | Highest quality. Pinterest-grounded visuals + image verification + canonical food identity. | ChatGPT/Gemini browser, big prompt template (`prompts-verified.js`) | Flow + per-image **verifier** (rejects + retries with fallback model) | Slower, higher quota use |
| **GV** (gemini-visual) | `mode: "gemini-visual"` | Tight visual continuity across a recipe (one persistent Gemini chat remembers every prior image). | Gemini chat | Gemini chat itself (no Flow). Network listener captures the bytes. | Free (subscription) |
| **scraper** | `mode: "scrape"` | Rewrite/replicate an existing online recipe. Input is a URL, not a topic. | Scrape page → ChatGPT cleans it up | Flow | Free |

The orchestrator class is picked in `src/routes.js` near `/api/start`:

```js
const OrchestratorClass =
  mode === 'scrape'         ? ScraperOrchestrator :
  mode === 'verified'       ? VerifiedGeneratorOrchestrator :
  mode === 'gemini-visual'  ? GeminiVisualOrchestrator :
                              GeneratorOrchestrator;
```

---

## 5. Recipe lifecycle (state machine)

Every mode is a state machine. The state lives in `data/sites/<name>/state.json` and is updated on every transition so you can crash-recover and resume.

Defined in `src/shared/utils/state-manager.js`:

```
IDLE
  │
  ▼
LOADING_JOB        ← read Sheet, pick next pending row
  │
  ▼
SELECTING_BACKGROUND ← pick hero bg + load kitchen backgrounds
  │
  ▼
GENERATING_RECIPE_JSON ← AI produces post_title, intro, steps[], prompts…
  │
  ▼
CREATING_FOLDERS   ← output/<recipe>/ + Flow project warmup
  │
  ▼
GENERATING_INGREDIENTS ← first Flow image
  │
  ▼
GENERATING_STEPS   ← loops over recipe.steps[]
  │
  ▼
GENERATING_HERO    ← wide plated shot
  │
  ▼
GENERATING_SERVING ← (GV only) tighter "money shot"
  │
  ▼
SAVING_FILES       ← persist all base64 → disk
  │
  ▼
UPLOADING_MEDIA    ← upload to WP via REST
  │
  ▼
PUBLISHING_DRAFT   ← build Gutenberg HTML, create draft post
  │
  ▼
GENERATING_PINS    ← 3 Pinterest pin images (uses template files)
  │
  ▼
UPLOADING_PINS     ← attach pins to the WP post meta
  │
  ▼
UPDATING_SHEET     ← write done + draft URL + pin data
  │
  ▼
COMPLETED          ← cleanup, advance batch index, loop
```

Plus mode-specific states:
- `PLANNING_VISUAL_STATES` (GV) — Gemini plans every shot upfront
- `SCRAPING_SITE`, `DOWNLOADING_IMAGES` (scraper)
- `ERROR`, `PAUSED` (any mode)

Each state has a handler method on the orchestrator. `BaseOrchestrator._runLoop()` reads the current state, calls its handler, and loops. The handler updates the state — that's the only way to advance.

---

## 6. Per-mode walkthrough

### Generator (default mode)

Files: `src/modules/generator/orchestrator.js`

Pipeline:
1. **Load job** — Sheet read, mark row "processing"
2. **Background select** — random hero bg + active-kitchen step backgrounds
3. **Recipe JSON** — sends `settings.recipePromptTemplate` to ChatGPT (or Gemini if `aiProvider === "gemini"`)
4. **Images** — each step calls `Flow.generate(prompt, backgroundPath, contextPaths, aspect, outputPath)`. Context = previous step image only.
5. **Hero** — same Flow call. Context = last step image.
6. **Save → Upload → Publish → Pins → Update Sheet → Complete**

Use when you want quick output with minimal complexity.

### VG (verified-generator)

Files: `src/modules/verified-generator/orchestrator.js`, `image-verifier.js`, `visual-planner.js`, `prompt-builder.js`, `prompts-verified.js`

What it adds on top of generator:

1. **Pinterest scraping** at recipe start — `scrapePinterestImages(ctx, query, refDir)` from `gemini-visual/pinterest-scraper.js`. Saves 3 finished-dish photos to `output/_vg-pinterest-cache/`. Attached to the AI chat as visual reference for the recipe JSON.
2. **Identity anchor** — for some recipes, scrapes another search query (the canonical raw food, e.g. "raw beef patty") to keep silhouettes consistent.
3. **Visual plan** — the AI returns not just a recipe but a `visual_plan` (ingredients_image, visual_steps[], hero_image specs).
4. **Multi-ref step images** — each step attaches: 1 Pinterest finished-dish ref + 1 identity anchor + previous step images (last 3: N-3, N-2, N-1) + kitchen background.
5. **Per-image verification** — after each Flow generation, `image-verifier.js` calls Gemini vision to check the result against the spec. Soft fail → retry with fallback model (Nano Banana Pro → Nano Banana 2 → Imagen 4).
6. **Structure randomization** — each post gets a different shuffled order of H2 sections (anti-AI-template signal for Google).

Use when quality matters more than speed. Slow but consistent.

### GV (gemini-visual)

Files: `src/modules/gemini-visual/orchestrator.js`, `prompts-gv.js`, `pinterest-scraper.js`

The big difference: **no Flow**. Everything goes through one Gemini chat session.

Pipeline:
1. **Pinterest scrape** — same as VG, 3 refs.
2. **Visual plan + recipe** — single Gemini call returns full JSON + visual_plan + serving_image spec.
3. **Image generation** — for each image, sends a new turn to the *same* Gemini chat. Gemini sees every prior image in the conversation, so step 5 looks like step 4. The network listener (`src/shared/utils/gemini-network-listener.js`) intercepts the image bytes from `googleusercontent.com/rd-gg-dl/` directly.
4. **Order**: ingredients → steps → hero → serving close-up → pins.

Trade-offs vs Flow:
- ✅ Stronger visual continuity (Gemini remembers context)
- ✅ Free (uses ChatGPT subscription)
- ❌ Single account, no rotation
- ❌ Slower than Flow per image

### Scraper

Files: `src/modules/scraper/orchestrator.js`

Topic column in the Sheet is a URL, not a recipe name. The scraper opens the URL, extracts the recipe content, runs it through ChatGPT to normalize/improve, then runs the standard image-gen + WP pipeline. Used to rewrite content from other blogs.

---

## 7. Browser automation: Playwright + Flow accounts

### Persistent context

`src/server.js → launchBrowserWithProfile(profileOverride)` uses `chromium.launchPersistentContext(profileDir, …)`. The profile dir survives between runs (login state is preserved). Default profile: `data/recipe-automator-profile`. Per-account profiles: `data/<account-name>/`.

**Critical**: when all open pages close, `launchPersistentContext` keeps the auto-spawned `about:blank` alive, so the context survives. But if `ctx.browserContext.close()` is explicitly called, the context is dead and any stale wrapper still pointing at it will throw `Target page, context or browser has been closed` on the next `newPage()`.

### Page wrappers

Thin classes that hold a `context` reference and expose `init()`, `sendPromptAndGetResponse()`, `generate()`, `close()`:

- `ChatGPTPage` — opens chatgpt.com
- `GeminiChatPage` — opens gemini.google.com for text
- `GeminiImageChat` — same Gemini, but for image generation; uses the network listener
- `FlowPage` — opens labs.google.com/flow; the biggest wrapper (1700+ lines)

The orchestrator caches them as `this.chatgpt`, `this.flow`, `this._geminiChat`, `this.gemini`. **Important**: when `_ensureBrowserForAccount` swaps the browser context (multi-account rotation), it must recreate every cached wrapper. Forgetting one (like `_geminiChat`) causes the dreaded "context closed" bug at recipe-to-recipe transitions.

### Multi-account Flow rotation

Files: `src/shared/utils/flow-account-manager.js`, `data/flow-accounts.json`

Flow rate-limits at ~100 images/account/day. To extend capacity, the user can register multiple Google accounts, each with its own profile dir. `_ensureProModelForNewRecipe()` rotates round-robin per recipe, closes the current context, and relaunches with the next account's profile.

This is why the browser closes/reopens between every recipe. Disable by setting all but one account to `enabled: false`.

### The Flow picker quirk

`Flow.generate()` attaches reference images via a picker dialog that auto-filters already-attached files. Pattern: try picker first, on miss fall back to upload+picker. The orchestrator caches uploaded filenames in `this._generatedNames` (a Map) so it can skip the wasteful picker-then-scroll-then-fail dance for files it knows haven't been uploaded yet. See `flow.js:_attachFromPicker` and the call sites in the same file.

---

## 8. Google Sheet integration

File: `src/shared/utils/sheets-api.js`

- **Reads**: public gviz endpoint (`docs.google.com/.../gviz/tq?…`). Sheet must be shared "anyone with link can view".
- **Writes**: Google Apps Script web app deployed by the user. URL in `settings.appsScriptUrl`. POST body: `{ spreadsheetId, range, values }`.

Status column workflow:
- Empty / `pending` → row to process
- `processing` → orchestrator picked it up
- `done` → finished, draft URL written to column C
- `error` → failed, error message in column C

Sheet tab + columns are mode-specific (see settings.json: `generatorSheetTab`, `verifiedGenSheetTab`, `scraperSheetTab`). Falls back to `single post` if unset.

---

## 9. WordPress integration

File: `src/shared/utils/wordpress-api.js`

REST API, Basic auth with an Application Password (stored in `settings.wpAppPassword`).

- Image upload: `POST /wp/v2/media` (multipart)
- Post create: `POST /wp/v2/posts` with full Gutenberg HTML in `content.raw`
- Post update: `POST /wp/v2/posts/<id>`
- Tasty Recipes meta: `meta` field on the post
- Pinterest pin data: stored in custom post meta

Post HTML is assembled by `src/modules/post-builder.js` from the recipe JSON using the configurable block template in `settings.postTemplate`.

**Never** save the WordPress `Additional CSS` via the posts endpoint — it creates a regular post with the CSS as text content (CLAUDE.md warns about this). Use the Customizer instead.

---

## 10. How to make changes safely

### Change a prompt

| Mode | File / setting |
|------|----------------|
| Generator | `settings.recipePromptTemplate` (dashboard or `settings.json`) |
| VG | `settings.verifiedGenerator.prompts.recipeVisualPlan` overrides the default in `src/modules/verified-generator/prompts-verified.js` |
| GV | `settings.geminiVisual.prompts.recipeVisualPlan` overrides `src/modules/gemini-visual/prompts-gv.js` |

All prompts use `{{placeholders}}` (VG/GV) or `@placeholders` (generator). The substitution chain lives in `_stepGenerateRecipeJSON`. If you add a new `{{placeholder}}` to the template, add the matching `.replace(/\{\{your_token\}\}/g, value)` to the orchestrator, otherwise the AI sees the raw token and may echo it back.

### Add a new mode

1. Create `src/modules/<mode>/orchestrator.js` extending `BaseOrchestrator`
2. Override `get _stepHandlers()` to return your state→handler map (merge `this._sharedHandlers`)
3. Add the mode to the `OrchestratorClass` switch in `src/routes.js` near `/api/start`
4. Optionally add settings under `settings.<mode>` and a dashboard UI tab
5. Add the mode key to `src/dashboard/dashboard.js` mode picker

Reuse what's already in `BaseOrchestrator` — most modes only need to override `_stepLoadJob` and `_stepGenerateRecipeJSON`.

### Change which images each step references

For Flow-based modes, every image step builds a `contextPaths` array and calls `this.flow.generate(prompt, bgPath, contextPaths, aspect, outputPath)`. Add or remove paths in that array. Be aware that Flow accepts roughly 3–5 refs well; more starts hurting prompt fidelity.

### Add a new image type (e.g. a thumbnail crop)

1. Add a state in `STATES` (e.g. `GENERATING_THUMBNAIL`)
2. Add a step handler in `BaseOrchestrator._sharedHandlers` or in your mode's orchestrator
3. Wire the transition: previous state's handler updates state to your new one
4. Add upload logic in `save-upload.js` if it needs to land on WordPress

### Add a new WordPress post block

Edit `src/modules/post-builder.js`. The `settings.postTemplate` array describes block ordering — add your new block type, then implement its renderer in `post-builder.js`.

---

## 11. Known gotchas & debugging tips

### Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `browserContext.newPage: Target page, context or browser has been closed` at recipe 2 start | Stale page-wrapper holds a closed context after `_ensureBrowserForAccount` swap | All cached wrappers must be nulled or recreated in `_ensureBrowserForAccount`. See `this._geminiChat = null` lines. |
| `[Flow] Picker: "x.jpg" not found after scrolling, closing` (recurring) | Trying to picker-attach a file never uploaded this session | Already mitigated — `_generatedNames` cache + skip-picker-for-unknown logic in `flow.js` |
| Gemini returns malformed JSON starting with `{{section_structure}}` | Unsubstituted template placeholder reaches the AI | Add the missing `.replace(/\{\{token\}\}/g, value)` in the prompt-fill chain |
| WordPress post created but missing recipe card | Tasty Recipes meta not attached | Check `wpAppPassword` permissions, `wprmEnabled` setting, `wprm` block in `post-builder.js` |
| `Apps Script write failed (500)` | Transient Google Apps Script error or quota | Retry. Add `_retryWrite` if it becomes frequent. |
| Same image saved across multiple steps | MD5 dedup catching a Gemini re-render OR a stale ref in the network listener | Check `GeminiImageChat._seenImageHashes`; verify network listener is bound to current turn |

### Debugging tools

- **Dashboard logs** (`localhost:3000`, "Logs" tab) — polls `/api/logs` every 2s
- **State inspection**: `data/sites/<site>/state.json` — current orchestrator state
- **Screenshots**: `screenshots/` dir captures Playwright moments. Auto-wiped in COMPLETED.
- **Standalone test scripts**:
  - `scripts/test-context-lifecycle.mjs` — Playwright context behavior
  - `scripts/test-orchestrator-swap.mjs` — recipe-to-recipe transition with real wrappers
  - `scripts/test-stale-context-ref.mjs` — bug repro
- **Codex CLI for diagnosis**: `/codex:rescue` from the Claude Code plugin (slow but thorough)

### When changing browser-related code

Run `scripts/test-context-lifecycle.mjs` after any change to `_ensureBrowserForAccount`, `_ensureContextAlive`, or the COMPLETED handler. The script reproduces the page lifecycle in ~3 seconds and surfaces context-death bugs before you run the full pipeline.

### Open issues to be aware of

1. **Gemini network listener turn-scoping** (`src/shared/utils/gemini-network-listener.js`) — `waitForImage` accepts any `/rd-gg-dl/` response after `reset()`, not specifically the one from the *current* StreamGenerate turn. A lazy refetch of an older image could be persisted. Bind capture to the current response id before scaling GV.
2. **`_ensureContextAlive` keeper page** — current check is null-ref only. If Chrome crashes or the user closes the window, `ctx.browserContext` is non-null but dead, and the next recipe fails on `newPage()`. Add a keeper page or a try/catch probe.
3. **Single-account ChatGPT bottleneck** — when Codex CLI is added, the whole pipeline could share one ChatGPT login. Plan for provider fallback (Codex → ChatGPT browser → Gemini) before scaling.

---

For one-off questions, the codebase has lots of inline comments — start at `src/modules/base-orchestrator.js` and follow the references. The state machine + `_stepHandlers` map is the only abstraction you really need to keep in your head.

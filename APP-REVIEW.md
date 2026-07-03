# Recipe Automator — Full App Review & Improvement Plan

> **Purpose of this file.** This is a working document written by Claude (Anthropic) for a
> cross-AI review. It explains how the whole app works step by step, module by module,
> then lists weaknesses and proposed enhancements.
>
> **Instructions for the Reviewer AI:** answer INLINE in the blocks marked
> `### 🤖 REVIEWER ANSWER` (keep the heading, write below it). You may also add
> comments anywhere using blockquotes prefixed with `> REVIEWER:`. Do not delete
> existing content — Claude will read your answers afterward and turn the agreed
> items into code changes.
>
> Last updated by Claude: 2026-07-03. Owner: Soufiane. Site: leagueofcooking.com.

---

## 1. What the app is

A Node.js (ESM) + Express + Playwright automation platform that runs a food blog
end-to-end with almost no human input:

- **Content creation**: reads recipe topics from a Google Sheet → generates a full
  blog post (recipe JSON) with Gemini/ChatGPT web UIs → generates all photos with
  Google Flow (ImageFX) → uploads to WordPress as a draft, SEO metadata included.
- **Distribution**: schedules and posts Pinterest pins through anti-detect browser
  profiles (Dolphin Anty), with human-like browsing sessions, account warmup tiers,
  and gradual WordPress publishing.
- **Control**: a single-page dashboard on `localhost:3000` (6 pages: Dashboard,
  Scraper, Verified, Planifier, Settings, Sites).

No paid AI APIs are used for generation — the app drives the **web UIs** of
Gemini/ChatGPT/Flow via Playwright with persistent logged-in Chromium profiles.
This is the app's biggest cost saving and its biggest fragility (selectors go stale).

---

## 2. End-to-end recipe creation, step by step (Verified Generator = "VG")

VG is the only active content pipeline (the old "generator" and "gemini-visual"
modes were deleted; "scraper" remains for URL-rewrite jobs). It is a state machine
(`src/shared/utils/state-manager.js` STATES) persisted to
`data/sites/{site}/state.json` after every transition, so a crash can resume.

The run loop (`base-orchestrator.js`) reads the current status and calls the
matching handler in `VerifiedGeneratorOrchestrator`:

| # | State | Handler | What happens |
|---|-------|---------|--------------|
| 1 | `LOADING_JOB` | `_stepLoadJob` | Read next pending row from the sheet tab (col A topic, col B status). Column Z = manual SEO keywords. Mark row `processing`. |
| 2 | `SELECTING_BACKGROUND` | `_stepSelectBackground` | Pick a kitchen/counter background photo (real photos the owner supplies) used as the surface reference in every Flow image. |
| 3 | `GENERATING_RECIPE_JSON` | `_stepGenerateRecipeJSON` | Scrape 3 Pinterest reference photos of the dish (`pinterest-scraper.js`). Build the giant prompt (`prompts-verified.js`): recipe + visual plan + 3 Pinterest pins in ONE JSON. Send to **Gemini web UI** (`gemini-chat.js`). Post-process: keyword injection (col Z), H2 structure randomization (now recipe-name-aware), pin coverage, image-SEO title backstop. |
| 4 | `CREATING_FOLDERS` | `_stepCreateFolders` | Create `output/{recipe}/`, prepare the Flow project. |
| 5 | `GENERATING_INGREDIENTS` | `_stepVerifiedIngredients` | First Flow image: raw ingredients scattered on the background. Refs attached: background. |
| 6 | `GENERATING_STEPS` | `_stepVerifiedStep` (loop) | One Flow image per recipe step. Refs: background (ref 1) + last 2 step images (+ Pinterest refs on the last/serving step). After each image, **Gemini vision verifies** it against the visual plan (`image-verifier.js`: PASS / SOFT_FAIL / HARD_FAIL) with a correction-prompt retry loop. |
| 7 | `GENERATING_HERO` | `_stepVerifiedHero` | Final plated wide shot. Refs: background + Pinterest + serving plate. Appetite-appeal prompt paragraph (steam, glisten, close-up texture). |
| 8 | `SAVING_FILES` | `_stepSaveFiles` | Persist base64 → disk. |
| 9 | `UPLOADING_MEDIA` | `_stepUploadMedia` | Upload all images to WP (`/wp/v2/media`, WebP conversion, alt/title/description from each image's seo object). |
| 10 | `PUBLISHING_DRAFT` | `_stepPublishDraft` | `post-builder.js` assembles ~32 Gutenberg blocks + Tasty Recipes card; create WP **draft**; nutrition API + content-quality gate (`content-quality.js` re-prompts failing sections). |
| 11 | `GENERATING_PINS` | `_stepVerifiedPins` | 3 Pinterest pin images via **Flow** using the owner's pin template images. Pin titles/descriptions come from the recipe JSON (3-intent split: search / curiosity / benefit + SEO booster word). |
| 12 | `UPLOADING_PINS` | `_stepUploadPins` | Pins uploaded to WP + written to `data/pinterest-data/post-{id}.json`. |
| 13 | `UPDATING_SHEET` | `_stepUpdateSheet` | Write `done`, draft URL, pin data back to the sheet (via Apps Script web app POST). |
| 14 | `COMPLETED` | — | Record VG stats, clean tmp, advance batch queue, loop to next topic. |

One recipe ≈ 45 min. Key design decisions:

- **Flow is a conversational chat now** (2026 UI): never double-click Create
  (second click = Stop). Classic mode with Agent pill deselected = 0 credits.
- **Reference discipline**: refs are numbered in the prompt matching the exact
  attach order (background = ref 1) — an off-by-one here silently breaks continuity.
- **Two-pass AI**: recipe JSON and visual plan are validated (`visual-planner.js`)
  and missing visual steps are synthesized.

---

## 3. The Planifier — scheduling & Pinterest automation

The planifier (`src/modules/planifier/`) turns the one-shot pipeline into a
hands-off daily operation across sites and Pinterest accounts.

### 3.1 Background engine (`planifier.js`)

Three timers armed at server boot:

- **weeklyTick** (30 min): on Sundays regenerates the plan horizon (J → J+horizonDays).
- **executorTick** (60 s): fires the oldest due pending plan item; skips while other
  automation is running (with `_busySince` tracking so time queued behind a healthy
  job doesn't count toward `missedSlotDropAfterMinutes`); on idle ticks it catches up
  slots previously marked `missed`; then delegates to campaign slots.
- **agingTick** (6 h): auto-promotes Pinterest accounts warmup_week_1 → 2 → 3 →
  active (7/14/28-day thresholds), each tier with its own pin-volume multiplier.

### 3.2 Day plans (`day-plan-builder.js`, `plan-storage.js`)

`buildDayPlan()` is a pure function: it collects "protos" (recipes to create +
pinterest/warming sessions per site/account), interleaves them, and places them in
the active-hour window with natural random gaps. Plans persist to
`data/planifier/plans/YYYY-MM-DD.json`. Rules (in `config.json`): active hours,
min gaps (global/inter-account/intra-account), skip-day probability, jitter,
`pinGapDays` (rolling gap between same-article pins, 3-pin cap, then evergreen
recycle of the oldest article), gradual publish (2-3 drafts/day at random times).

### 3.3 Executing an item (`action-executor.js`)

`runPlanItem()` handles exactly 3 item types:

1. **`create-recipe`** — wraps the VG orchestrator as a 1-recipe batch.
2. **`pinterest-session`** — pick an eligible pin (`pin-pool.js`, sheet-backed),
   verify the recipe is **published** on WP (fail-closed guard — drafts never get
   pinned), resolve the board from the WP category (`boards-validator.js` scrapes
   real board names, 24h cache), start the Dolphin Anty profile → CDP connect →
   replay a simulated human browse session (`browse-simulator.js` → `pinterest.js`)
   → create the pin. Since 2026-07-03 sessions **never save other people's pins**
   and never visit `/ideas/` (owner request).
3. **`warming-session`** — 15-25 min browse-only session for young accounts
   (category searches, scrolls, closeups — saves disabled).

Every item transitions pending → in_progress → done/error/missed with history and
Telegram notifications.

### 3.4 Campaigns & pin tooling

- **campaigns-executor.js**: fires due slots from the `pin-campaigns` sheet
  (regenerate pins for a URL → auto-post immediately).
- **pin-regenerator.js**: regenerate a single pin image (hero + template via Flow),
  queue persisted to disk, modes replace/extra.
- **recipe-validator.js**: gates pin posting on recipe quality (JSON-LD extraction,
  ingredient reconciliation).
- **internal-link-auditor.js**: scans published posts for broken/missing internal
  links and can apply fixes.

---

## 4. Supporting layers

- **Page objects** (`src/shared/pages/`): `flow.js` (+`flow-download`/`flow-cleanup`,
  the biggest and most fragile), `gemini-chat.js`, `chatgpt.js`, `pinterest.js`
  (humanized clicks/typing over Dolphin CDP), `ui-triggers.js` (central selector
  registry powering `npm run check-triggers` — the live selector health check).
- **Sheets, two paths**: `sheets-api.js` (legacy public gviz read + Apps Script
  write) and `sheets-client.js` (new googleapis service-account read/write for
  sites-config / pin-campaigns / pin-history). Two parallel mechanisms for the
  same spreadsheet family.
- **wordpress-api.js**: REST with Application Password; media upload sends
  alt_text/title/description; posts as draft/future/publish.
- **dolphin-anty.js**: cloud API (profiles) + local API (start/stop → CDP port).
- **flow-account-manager.js**: rotates multiple Google accounts around Flow's
  ~100 images/day limit, one Chromium profile per account.
- **State/config**: `state-manager.js` per-site settings+state under
  `data/sites/{site}/`; `sites-config.js` reads the sites-config sheet tab
  (cross-PC source of truth). Playwright profiles are sacred — never delete
  (logins are unrecoverable).
- **Server**: `server.js` boots Express (port 3000) + planifier tickers.
  `routes.js`: ~131 endpoints in one 2,784-line file.
- **Dashboard**: vanilla-JS SPA; `dashboard.js` ~174 KB, `planifier.js` ~184 KB
  (Planifier page alone has 9 sub-tabs).

---

## 5. Known weaknesses (Claude's honest assessment)

Ordered roughly by how much pain they cause:

1. **Web-UI selector fragility** — Gemini/ChatGPT/Flow/Pinterest UIs change every
   few weeks; failures are slow and silent (10-min hangs, truncated JSON).
   `ui-triggers.js` + `check-triggers` covers Gemini/ChatGPT but **not Flow or
   Pinterest**, and it is run manually, not automatically before pipelines.
2. **Config sprawl** — per-site data is duplicated across `settings.json`,
   planifier `config.json`, the sites-config sheet tab, and `flow-accounts.json`
   (sheet tab names, Dolphin tokens, Pinterest accounts appear in more than one
   place). A planned refactor (one `site.json` per site) exists but hasn't run.
3. **Monoliths** — `routes.js` (2,784 lines, 131 endpoints), `flow.js` (1,700+),
   `dashboard.js`/`planifier.js` (~360 KB combined, no framework, no build step).
   Every change is a needle-in-haystack edit.
4. **Two sheet integrations** — gviz+AppsScript vs googleapis service account.
   Double the auth failure modes; the gviz path requires the sheet to be public.
5. **No automated tests** — verification is "run a recipe and watch". The pure
   modules (day-plan-builder, browse-simulator, prompt-builder) are trivially
   unit-testable but nothing runs them in CI. Regressions surface days later as
   missed pin slots or malformed posts.
6. **Error handling habits** — several guards used to fail-open (the draft-pin bug:
   unauthenticated WP 401 let draft URLs through). One audit pass fixed the pin
   guard; other fail-open spots likely remain.
7. **Secrets in plaintext** — WP app passwords, Dolphin JWT, Telegram token,
   service-account JSON all sit unencrypted in `data/` on a Windows desktop.
8. **Single-machine, single-thread pipeline** — one recipe at a time (~45 min);
   browser automation pins the machine. Flow account rotation helps quota, not
   throughput. The planifier serializes everything behind `automationRunning`.
9. **Observability gaps** — logs are in-memory + dashboard polling; no persistent
   structured log file per recipe, so post-mortems on "why did last night's run
   fail" depend on what's still in the buffer. VG stats exist but nothing trends
   selector failures or verification-retry rates over time.
10. **Docs drift** — `ARCHITECTURE.md` still documents deleted modes
    (generator/gemini-visual/regen as pipelines).

---

## 6. Proposed enhancements (for review)

### P1 — highest value / lowest risk

- **E1. Extend `ui-triggers.js` to Flow and Pinterest** and auto-run
  `check-triggers --no-roundtrip` at the start of every batch (fail fast with a
  Telegram alert naming the exact stale trigger).
- **E2. Execute the config centralization refactor** (single `data/sites/{site}/site.json`
  with everything: sheet tabs, WP creds, Dolphin, Pinterest accounts, prompts refs).
  Migration script + backward-compat reads for one release.
- **E3. Unit tests for the pure core** (day-plan-builder, browse-simulator,
  prompt-builder, pin-pool row parsing, expandPinterestDescription) with `node:test`.
  Zero new dependencies, minutes to run, catches the regressions that hurt.
- **E4. Persistent structured logs** — append JSONL per recipe run
  (`output/{recipe}/run-log.jsonl`) + a rolling `data/logs/server-YYYY-MM-DD.log`.

### P2 — medium effort

- **E5. Split routes.js** into express.Router modules (core, planifier, pins,
  settings, assets) — mechanical, no behavior change.
- **E6. Migrate all sheet access to `sheets-client.js`** (service account), delete
  the gviz+AppsScript path, make the sheet private.
- **E7. Failure-rate dashboard**: trend VG verification retries, Flow generation
  failures, selector-check results over time (data mostly exists in vg-stats).
- **E8. Crash-resume hardening**: on boot, if state.json is mid-recipe, offer
  resume-from-state in the dashboard instead of silently sitting idle.

### P3 — bigger bets (need owner/reviewer input)

- **E9. Parallelism**: run image generation for recipe N+1's JSON while recipe N
  is uploading (two browser contexts). Roughly halves wall-clock per recipe day.
- **E10. Provider abstraction**: one `AiChatProvider` interface over
  gemini-chat/chatgpt (and future providers), so switching or falling back doesn't
  touch orchestrator code.
- **E11. Local DB (SQLite) for operational state** (plans, history, pin pool
  cache) with the sheet demoted to import/export — removes race conditions and
  rate limits, keeps the sheet as the human interface.
- **E12. Dashboard rebuild** in small steps (extract API client, then split each
  page into modules; optionally Vite + a light framework later).

---

## 7. Questions for the Reviewer AI

Please answer each one inline below its heading.

### Q1. Priority check
Given section 5, do you agree P1 items (E1–E4) are the right first wave? What
would you reorder and why?

### 🤖 REVIEWER ANSWER


### Q2. Selector fragility strategy
Beyond a health check registry, what's the most robust long-term approach for
driving Gemini/Flow/Pinterest web UIs from Playwright when we cannot use paid
APIs? (e.g. accessibility-tree-first selectors, LLM-powered self-healing locators,
screenshot+vision fallback, record/replay drift detection…) Recommend ONE
approach worth implementing here, with a sketch.

### 🤖 REVIEWER ANSWER


### Q3. Sheet vs database
Is E11 (SQLite as source of truth, sheet as UI/import-export) the right call for
a solo operator running 1-3 sites, or is it over-engineering? Answer with the
failure modes you'd expect from keeping the sheet as the DB.

### 🤖 REVIEWER ANSWER


### Q4. Pinterest anti-detection
The bot now: browses with weighted human-like "beats", never saves others' pins,
never visits /ideas/, uses Dolphin Anty profiles, warms accounts through tiers,
paces pins with rolling gaps. What detection vectors remain that we're blind to,
and what ONE change would most reduce ban risk?

### 🤖 REVIEWER ANSWER


### Q5. Content quality / SEO
The pipeline now enforces: exact-topic repetition in body/meta/H2s/image
metadata, column-Z keyword phrases in pins, 3-intent pin titles with booster
words, randomized H2 structure, readability rules (Yoast), internal linking,
content-quality re-prompts. What is missing or overdone from a 2026 Google/
Pinterest SEO perspective? Flag anything that risks an over-optimization penalty.

### 🤖 REVIEWER ANSWER


### Q6. Architecture risks we haven't listed
Read section 5 skeptically: what important weakness did Claude miss?

### 🤖 REVIEWER ANSWER


### Q7. Quick wins
Name up to 3 improvements not in section 6 that take <1 day each and pay off
immediately.

### 🤖 REVIEWER ANSWER


---

*End of Claude's part. Reviewer: edit only inside the answer blocks / blockquotes.
Claude will read this file afterward, discuss with the owner, and implement.*

# Tennis Stats PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an installable, local-first tennis statistics PWA that records matches manually or through reviewed AI voice drafts, preserves data through migrations/backups, and deploys `develop` to GitHub Pages.

**Architecture:** Build vertical slices on a React/Vite shell while keeping tennis rules, statistics, persistence, AI providers, and browser platform services behind explicit TypeScript interfaces. IndexedDB is authoritative for tennis data and pending recordings; local storage contains only AI/settings values. Every AI result is schema-validated and remains a draft until the user confirms it.

**Tech Stack:** Node 22, npm, React, TypeScript, Vite, React Router, Dexie, Zod, date-fns, Recharts, vite-plugin-pwa, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-tennis-stats-design.md`

## Global Constraints

- Deploy from `develop` to `https://js-headquaters.github.io/tennis-stats/`; Vite, router, manifest, and service-worker scope must use `/tennis-stats/`.
- Primary targets are current iPhone Safari and Chrome on iOS; desktop browsers are secondary.
- Keep tennis data and pending recordings in IndexedDB; keep AI credentials/settings in local storage and exclude them from logs, caches, tests, and exports.
- Persist unknown numeric statistics as `null`; only an explicitly entered zero is `0`.
- Never persist AI-created match records before explicit confirmation.
- Track only the player's net, wide, long, double-fault, and failed-return statistics; `failedReturns` is valid only for return games.
- Use a statistics-first mobile UI, softened lime headers, dark-gray text, muted borders, 44px touch targets, and large separated statistic cells.
- Keep OpenAI transcription and OpenAI/Anthropic parsing replaceable through interfaces.
- All paid-provider behavior in tests must use deterministic network mocks; no real API keys or paid requests.
- Make schema/data migrations forward-only and preserve data on failure rather than resetting it.

## Review Focus

1. A reload, failed AI request, or lost network during recording must retain the pending audio/draft and never create duplicate games — pinned in Task 8.
2. `null` and `0` must remain distinct through validation, UI edits, IndexedDB, backup round trips, and dashboard averages — pinned in Tasks 2, 4, 7, 9, and 11.
3. Editing an early game must surface downstream serving/scoring conflicts instead of silently rewriting later records — pinned in Tasks 3 and 7.
4. Provider errors or diagnostics must never expose an API key, authorization header, or raw secret in rendered/logged output — pinned in Task 6.
5. iOS WebKit microphone format/permission failure must retain manual entry and a recoverable recording state — pinned in Tasks 8 and 12.

---

## File Map

### Foundation

- `package.json`, `package-lock.json` — scripts and pinned dependency graph.
- `vite.config.ts`, `tsconfig*.json`, `eslint.config.js` — build/type/lint/PWA setup.
- `index.html`, `public/icons/*`, `src/main.tsx`, `src/app/App.tsx`, `src/app/router.tsx`, `src/app/dependencies.ts` — application entry, hash routes, and dependency wiring.
- `src/styles/tokens.css`, `src/styles/global.css` — selected visual tokens and shared mobile/accessibility rules.
- `src/test/setup.ts`, `playwright.config.ts` — unit/component and E2E harnesses.

### Domain and application

- `src/domain/model.ts` — shared entity/value types.
- `src/domain/validation.ts` — domain constructors and cross-field validation.
- `src/domain/scoring.ts` — serving, set, tie-break, and match evaluation.
- `src/domain/statistics.ts` — calendar period ranges, averages, and trends.
- `src/application/ports.ts` — repository, clock, ID, settings, transcription, and parser interfaces.
- `src/application/matchService.ts` — match lifecycle and correction orchestration.
- `src/application/draftService.ts` — audio/transcript/draft/confirmation orchestration.
- `src/application/backupService.ts` — versioned export/import validation and merge/replace.

### Persistence and providers

- `src/infrastructure/db/schema.ts`, `database.ts`, `repositories.ts`, `migrations.ts` — Dexie schema, repositories, and semantic migrations.
- `src/infrastructure/settings/localSettings.ts` — local-storage AI settings with redaction helpers.
- `src/infrastructure/ai/openAiTranscription.ts`, `openAiParser.ts`, `anthropicParser.ts`, `schemas.ts` — provider adapters and strict response schema.
- `src/infrastructure/audio/mediaRecorder.ts` — iOS-aware recording adapter and MIME fallback.
- `src/infrastructure/backup/fileTransfer.ts` — browser download/upload adapter.

### Features

- `src/components/AppShell.tsx`, `MetricCell.tsx`, `ErrorBoundary.tsx` — shared UI.
- `src/features/dashboard/*` — calendar period dashboard and recent/active match cards.
- `src/features/matches/StartMatchPage.tsx`, `ActiveMatchPage.tsx`, `GameForm.tsx`, `GameCard.tsx`, `TieBreakForm.tsx`, `MatchHistoryPage.tsx`, `MatchDetailsPage.tsx` — match workflows.
- `src/features/voice/RecordPage.tsx`, `DraftReviewPage.tsx`, `DraftGameCard.tsx` — voice capture and iterative review.
- `src/features/settings/SettingsPage.tsx`, `AiSettingsSection.tsx`, `DataSettingsSection.tsx` — provider and backup settings.

### Delivery

- `tests/e2e/*.spec.ts`, `tests/e2e/fixtures.ts` — critical browser journeys and deterministic AI/database fixtures.
- `.github/workflows/ci.yml`, `.github/workflows/pages.yml` — required checks and GitHub Pages deployment.
- `docs/ios-smoke-test.md` — real-device checks that browser automation cannot faithfully reproduce.

---

### Task 1: Repository, Toolchain, App Shell, and Baseline Tests

**Files:**
- Create: `.gitignore`, `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `eslint.config.js`, `index.html`
- Create: `src/main.tsx`, `src/app/App.tsx`, `src/app/router.tsx`, `src/components/AppShell.tsx`, `src/features/dashboard/DashboardPage.tsx`, `src/styles/tokens.css`, `src/styles/global.css`
- Create: `src/test/setup.ts`, `src/app/App.test.tsx`, `playwright.config.ts`, `tests/e2e/shell.spec.ts`
- Preserve: `docs/superpowers/specs/2026-11-11-tennis-stats-design.md`, `docs/superpowers/plans/2026-11-11-tennis-stats-pwa.md`

**Interfaces:**
- Produces: hash routes `/`, `/matches`, `/matches/new`, `/matches/:matchId`, `/matches/:matchId/live`, `/voice/:draftId`, `/settings`; scripts `dev`, `build`, `typecheck`, `lint`, `test`, `test:e2e`.

- [x] **Step 1: Initialize the empty remote locally without losing planning files**

Run `git init -b develop`, add remote `git@github.com:js-headquaters/tennis-stats.git`, confirm `git ls-remote origin` is empty, and add `.superpowers/`, `node_modules/`, `dist/`, `playwright-report/`, `test-results/`, and `.env*` to `.gitignore`.

- [x] **Step 2: Write failing shell tests**

In `src/app/App.test.tsx`, assert the mobile nav exposes Home, Matches, and Settings and the dashboard has an accessible “Start new match” link. In `tests/e2e/shell.spec.ts`, open `/tennis-stats/#/settings` and assert the Settings hash route survives reload.

- [x] **Step 3: Run tests and verify the missing scaffold fails**

Run `npm test -- src/app/App.test.tsx` and `npm run test:e2e -- tests/e2e/shell.spec.ts`; expect missing scripts/modules or assertions to fail.

- [x] **Step 4: Create the React/Vite scaffold and shared visual shell**

Set Vite `base: "/tennis-stats/"`, use `HashRouter` so GitHub Pages reloads do not require a server fallback, configure jsdom/Testing Library, install the Chromium Playwright browser, and implement softened lime headers, dark-gray text, muted borders, safe-area padding, visible focus, and 44px minimum controls. Use placeholder route pages only where later tasks replace them.

- [x] **Step 5: Run baseline quality checks**

Run `npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e -- tests/e2e/shell.spec.ts`; expect every command to exit 0 and the production asset URLs to begin with `/tennis-stats/`.

- [x] **Step 6: Commit the foundation and approved documents**

Run `git add . && git commit -m "chore: bootstrap tennis stats pwa"`.

---

### Task 2: Domain Model and Validation

**Files:**
- Create: `src/domain/model.ts`, `src/domain/validation.ts`
- Test: `src/domain/validation.test.ts`

**Interfaces:**
- Produces: `Opponent`, `Match`, `TennisSet`, `Game`, `TieBreak`, `VoiceDraft`, `MatchBundle`, `DatabaseSnapshot`, `RecordedMetric`, `Server`, `MatchFormat`, `MatchStatus`, `ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }`; `validateGame(input: Game): ValidationResult<Game>` and `normalizeOpponentName(name: string): string`.

- [x] **Step 1: Write failing domain validation tests**

Cover stable IDs/timestamps, trimmed non-empty opponent names, integer-or-null metrics, explicit preservation of `0`, rejection of negative/fractional counts, rejection of `failedReturns` in a player service game, and rejection of `doubleFaults` in an opponent service game.

- [x] **Step 2: Run the tests and verify failure**

Run `npm test -- src/domain/validation.test.ts`; expect missing model/validator failures.

- [x] **Step 3: Implement the exact domain types and validators**

Use string IDs and ISO timestamp strings. Store ordered relationships with `ordinal` fields rather than duplicated arrays on parent records; keep optional game score as `{ player: "0" | "15" | "30" | "40" | "AD"; opponent: same } | null` and all five statistics as `number | null`.

- [x] **Step 4: Verify domain tests and type checking**

Run `npm test -- src/domain/validation.test.ts && npm run typecheck`; expect all checks to pass.

- [x] **Step 5: Commit**

Run `git add src/domain && git commit -m "feat: define tennis domain model"`.

---

### Task 3: Tennis Scoring, Serving, and Correction Conflicts

**Files:**
- Create: `src/domain/scoring.ts`
- Test: `src/domain/scoring.test.ts`

**Interfaces:**
- Consumes: `Game`, `TennisSet`, `TieBreak`, `MatchFormat`, `Server` from Task 2.
- Produces: `inferServer(first: Server, zeroBasedGameIndex: number): Server`; `evaluateSet(games: Game[], tieBreak: TieBreak | null): SetEvaluation`; `evaluateMatch(format: MatchFormat, sets: SetEvaluation[]): MatchEvaluation`; `findCorrectionConflicts(before: Game[], after: Game[]): CorrectionConflict[]`.

- [ ] **Step 1: Write failing scoring tests**

Assert alternating service; valid standard endings 6–0, 6–4, 7–5, and 7–6 with a tie-break; no automatic ending at 6–5 or 6–6; split first two sets requiring a super tie-break; one-set and best-of-three completion; unfinished sets never counting as wins; and open/practice requiring manual completion.

- [ ] **Step 2: Add failing correction-conflict tests**

Assert that deleting or inserting an early game reports later explicit servers whose inferred server changed and reports a completed set/match whose derived outcome became invalid; do not silently mutate those records.

- [ ] **Step 3: Run tests and verify failure**

Run `npm test -- src/domain/scoring.test.ts`; expect missing functions.

- [ ] **Step 4: Implement pure scoring functions**

Keep all functions deterministic and side-effect free. A standard tie-break decides a set only from 6–6; a deciding super tie-break is a `TennisSet` with `kind: "decidingSuperTiebreak"` and no normal games.

- [ ] **Step 5: Verify and commit**

Run `npm test -- src/domain/scoring.test.ts && npm run typecheck`, then `git add src/domain && git commit -m "feat: add tennis scoring rules"`.

---

### Task 4: IndexedDB Schema, Repositories, and Migration Guard

**Files:**
- Create: `src/application/ports.ts`, `src/app/dependencies.ts`
- Create: `src/infrastructure/db/schema.ts`, `database.ts`, `repositories.ts`, `migrations.ts`
- Test: `src/infrastructure/db/repositories.test.ts`, `migrations.test.ts`

**Interfaces:**
- Produces: `TennisRepository` with transaction methods `getActiveMatch()`, `getMatchBundle(id)`, `listMatches(filter)`, `saveMatchBundle(bundle)`, `deleteMatch(id)`, `saveDraft(draft)`, `getDraft(id)`, `deleteDraft(id)`, `listOpponents()`, and `replaceAll(snapshot)`; `Clock.now(): string`; `IdGenerator.next(): string`; `openDatabase(): Promise<TennisRepository>`; `runDataMigrations(db, fromVersion, toVersion): Promise<void>`; one application dependency container wired in `src/app/dependencies.ts`.

- [ ] **Step 1: Write failing repository contract tests**

Use fake-indexeddb to assert complete match-bundle transactions, one active match, reusable opponent lookup, ordinal ordering, draft Blob round-trip, and `null`/`0` preservation.

- [ ] **Step 2: Write failing migration-guard tests**

Seed a version-0 fixture, migrate to version 1, reopen, and assert idempotence. Force a migration exception and assert the original records remain and the repository enters read-only recovery instead of clearing the database.

- [ ] **Step 3: Run tests and verify failure**

Run `npm test -- src/infrastructure/db`; expect missing adapters.

- [ ] **Step 4: Implement Dexie schema version 1 and repositories**

Create stores/indexes for opponents, matches, sets, games, tieBreaks, drafts, and metadata. Keep the repository interface free of Dexie types and wrap multi-table writes in one transaction.

- [ ] **Step 5: Verify and commit**

Run `npm test -- src/infrastructure/db && npm run typecheck`, then `git add src/application/ports.ts src/app/dependencies.ts src/infrastructure/db && git commit -m "feat: persist versioned tennis data"`.

---

### Task 5: Opponents and Starting a Match

**Files:**
- Create: `src/application/matchService.ts`, `src/application/matchService.test.ts`
- Create: `src/features/matches/StartMatchPage.tsx`, `src/features/matches/StartMatchPage.test.tsx`
- Modify: `src/app/router.tsx`, `src/features/dashboard/DashboardPage.tsx`

**Interfaces:**
- Consumes: `TennisRepository`, domain validators, `inferServer`.
- Produces: `startMatch(input: StartMatchInput, deps: MatchServiceDeps): Promise<MatchBundle>` and `abandonActiveMatch(id, deps): Promise<void>`; `StartMatchInput` contains opponent name/ID, ISO `playedAt`, format, and first server.

- [ ] **Step 1: Write failing service tests**

Assert existing opponents are reused case-insensitively, a new opponent is created inline, the default format is `twoSetsSuperTiebreak`, and starting while a match is active returns an actionable conflict rather than creating a second active match.

- [ ] **Step 2: Write failing component tests**

Assert the format order from the spec, editable date/time, searchable opponent suggestions, new-opponent creation, first-server choice, and explicit complete/abandon prompt when an active match exists.

- [ ] **Step 3: Run tests and verify failure**

Run `npm test -- src/application/matchService.test.ts src/features/matches/StartMatchPage.test.tsx`; expect failures.

- [ ] **Step 4: Implement the vertical slice**

Create a match with standard set ordinal 1, navigate to `/matches/:id/live`, and show an active-match resume card on the dashboard.

- [ ] **Step 5: Verify and commit**

Run `npm test -- src/application/matchService.test.ts src/features/matches/StartMatchPage.test.tsx && npm run typecheck`, then run `git add src && git commit -m "feat: start matches with reusable opponents"`.

---

### Task 6: AI Settings, Redaction, and Provider Adapters

**Files:**
- Create: `src/infrastructure/settings/localSettings.ts`, `localSettings.test.ts`
- Create: `src/infrastructure/ai/schemas.ts`, `openAiTranscription.ts`, `openAiParser.ts`, `anthropicParser.ts`, `providers.test.ts`
- Create: `src/features/settings/SettingsPage.tsx`, `AiSettingsSection.tsx`, `SettingsPage.test.tsx`
- Modify: `src/application/ports.ts`, `src/app/router.tsx`

**Interfaces:**
- Produces: `AiSettingsStore` with `getTranscription()`, `saveTranscription()`, `getParser()`, `saveParser()`, `clear(kind)`; `TranscriptionProvider.transcribe(request, signal): Promise<Transcript>`; `StatisticsParser.parse(request, signal): Promise<ParsedDraft>`; `redactProviderError(error): SafeProviderError`.

- [ ] **Step 1: Write failing settings tests**

Assert transcription and parser settings save independently, masked inputs do not overwrite an unchanged key, clearing one leaves the other, and serialization/export helpers never include keys.

- [ ] **Step 2: Write failing provider contract tests**

Mock fetch and assert OpenAI multipart transcription, OpenAI structured parser output, Anthropic structured parser output, Zod rejection of malformed/negative/cross-field-invalid drafts, cancellation, and safe mapping of auth/rate/network failures.

- [ ] **Step 3: Add secret-leak regression tests**

Use a sentinel key and assert it is absent from thrown messages, `JSON.stringify` diagnostics, rendered Settings errors, and intercepted console calls.

- [ ] **Step 4: Run tests and verify failure**

Run `npm test -- src/infrastructure/settings src/infrastructure/ai src/features/settings/SettingsPage.test.tsx`; expect failures.

- [ ] **Step 5: Implement adapters and Settings UI**

Default transcription to current OpenAI `gpt-transcribe`; keep model and endpoint editable. Support OpenAI and Anthropic parser adapters, “Test connection,” clear-key actions, and the exact client-key risk warning from the spec.

- [ ] **Step 6: Verify and commit**

Run targeted tests, `npm run typecheck`, and `npm run lint`; then commit `feat: configure replaceable ai providers`.

---

### Task 7: Manual Game Entry, Active Match, Sets, Tie-breaks, and Corrections

**Files:**
- Modify: `src/application/matchService.ts`, `src/application/matchService.test.ts`
- Create: `src/features/matches/ActiveMatchPage.tsx`, `GameForm.tsx`, `GameCard.tsx`, `TieBreakForm.tsx`, associated `*.test.tsx`
- Modify: `src/app/router.tsx`

**Interfaces:**
- Produces: `addGames(matchId, inputs, deps)`, `updateGame(gameId, patch, deps)`, `deleteGame(gameId, deps)`, `completeTieBreak(input, deps)`, `endSetEarly(setId, deps)`, `finishMatch(id, deps)`; every correction returns `{ bundle, conflicts }`.

- [ ] **Step 1: Write failing service tests**

Assert batch insertion preserves explicit `null` and `0`, infers/stores alternating servers, validates failed returns/double faults by server, auto-completes standard sets and configured matches, creates standard/super tie-break prompts, marks early sets unfinished, and returns correction conflicts without rewriting later servers.

- [ ] **Step 2: Write failing UI tests**

Assert readable separate metric cells, won/lost text labels, unknown `—`, manual form behavior, set/match actions, comments entry, and a conflict confirmation screen before structurally disruptive edits.

- [ ] **Step 3: Run tests and verify failure**

Run `npm test -- src/application/matchService.test.ts src/features/matches`; expect failures.

- [ ] **Step 4: Implement active-match and correction workflows**

Keep the primary voice action and secondary manual action visible. Persist each confirmed service operation transactionally and derive all displayed scores through Task 3 functions.

- [ ] **Step 5: Verify and commit**

Run targeted tests plus `npm run typecheck && npm run lint`; commit `feat: manage live matches and corrections`.

---

### Task 8: iOS Recording, Offline Drafts, AI Review, and Confirmation

**Files:**
- Create: `src/infrastructure/audio/mediaRecorder.ts`, `mediaRecorder.test.ts`
- Create: `src/application/draftService.ts`, `draftService.test.ts`
- Create: `src/features/voice/RecordPage.tsx`, `DraftReviewPage.tsx`, `DraftGameCard.tsx`, associated `*.test.tsx`
- Modify: `src/app/router.tsx`

**Interfaces:**
- Produces: `AudioRecorder.start(): Promise<void>`, `stop(): Promise<RecordedAudio>`, `cancel(): Promise<void>`; `createDraftFromAudio`, `retryDraft`, `refineDraftWithAudio`, `updateDraftGame`, and `confirmDraft` application functions.

- [ ] **Step 1: Write failing recording-adapter tests**

Assert MIME selection tries supported `audio/mp4`/AAC-compatible options before WebM on iOS, handles permission denial, stop/cancel, empty recordings, and preserves a recoverable Blob when upload fails.

- [ ] **Step 2: Write failing draft-service tests**

Assert audio is saved before network calls, transcript history is retained, parser receives current match/expected server/existing draft, refinement replaces the draft only after valid output, confirmation writes all games once transactionally, duplicate confirmation is idempotent, and confirmed audio is deleted.

- [ ] **Step 3: Write failing UI tests**

Assert recording states, safe provider errors, offline “waiting to retry,” transcript visibility, editable large-stat draft cards, “Add or correct by voice,” and “Confirm and add.” Assert manual entry remains available after permission/format failure.

- [ ] **Step 4: Run tests and verify failure**

Run `npm test -- src/infrastructure/audio src/application/draftService.test.ts src/features/voice`; expect failures.

- [ ] **Step 5: Implement the end-to-end draft workflow**

Use repository drafts as the source of truth across reloads. Generate an idempotency marker per confirmation and prevent double submission while provider calls are pending.

- [ ] **Step 6: Verify and commit**

Run targeted tests, type checking, and linting; commit `feat: add reviewed voice game entry`.

---

### Task 9: Calendar Dashboard and Trends

**Files:**
- Create: `src/domain/statistics.ts`, `src/domain/statistics.test.ts`
- Create: `src/features/dashboard/DashboardPage.tsx`, `MetricCard.tsx`, `TrendChart.tsx`, associated `*.test.tsx`
- Modify: `src/app/router.tsx`

**Interfaces:**
- Produces: `getCalendarPeriod(reference: Date, unit: "week" | "month"): DateRange`; `calculateMetric(games, key): MetricSummary`; `calculateDashboard(current, previous): DashboardSummary`.

- [ ] **Step 1: Write failing statistics tests**

Use timezone-safe fixtures to assert Monday–Sunday weeks, calendar-month boundaries, previous-equivalent periods, match `playedAt` inclusion, per-metric known-value denominators, explicit-zero inclusion, tie-break exclusion, and failed-return denominator restricted to known return games.

- [ ] **Step 2: Write failing dashboard tests**

Assert week/month navigation, current-versus-previous trend text, sample sizes, net/wide/long/double-fault averages, failed returns per return game, recent matches, active resume, and no raw totals.

- [ ] **Step 3: Run tests and verify failure**

Run `npm test -- src/domain/statistics.test.ts src/features/dashboard`; expect failures.

- [ ] **Step 4: Implement pure statistics and statistics-first UI**

Use Recharts behind `TrendChart`; include a text equivalent for every visualization and avoid implying improvement when either comparison period has no sample.

- [ ] **Step 5: Verify and commit**

Run targeted tests plus type checking/linting; commit `feat: show calendar tennis trends`.

---

### Task 10: Match History, Details, Filters, and Post-match Editing

**Files:**
- Create: `src/features/matches/MatchHistoryPage.tsx`, `MatchDetailsPage.tsx`, `MatchFilters.tsx`, associated `*.test.tsx`
- Modify: `src/application/matchService.ts`, `src/app/router.tsx`

**Interfaces:**
- Consumes: repository filters `{ opponentId?: string; from?: string; to?: string }` and correction functions from Task 7.
- Produces: newest-first history, reusable opponent/date filters, completed/unfinished/abandoned labels, editable comments and match records without reactivation.

- [ ] **Step 1: Write failing page tests**

Assert newest-first ordering, opponent/date filtering, set/game/tie-break detail, per-match averages/sample sizes, comments, completed-record editing, and that editing never changes status back to active.

- [ ] **Step 2: Run tests and verify failure**

Run `npm test -- src/features/matches/MatchHistoryPage.test.tsx src/features/matches/MatchDetailsPage.test.tsx`; expect failures.

- [ ] **Step 3: Implement history and details**

Reuse Task 7 forms/cards instead of introducing separate edit semantics. Show incomplete and unknown states in text, not color alone.

- [ ] **Step 4: Verify and commit**

Run targeted tests, type checking, and linting; commit `feat: browse and edit match history`.

---

### Task 11: Versioned Backup, Restore, and Data Settings

**Files:**
- Create: `src/application/backupService.ts`, `backupService.test.ts`
- Create: `src/infrastructure/backup/fileTransfer.ts`, `fileTransfer.test.ts`
- Create: `src/features/settings/DataSettingsSection.tsx`, `DataSettingsSection.test.tsx`
- Create: `src/test/fixtures/backup-v0.json`, `backup-v1.json`
- Modify: `src/features/settings/SettingsPage.tsx`

**Interfaces:**
- Produces: `exportBackup(repo): Promise<BackupV1>`; `previewImport(raw): ImportPreview`; `applyImport(preview, mode: "merge" | "replace", repo): Promise<ImportResult>`.

- [ ] **Step 1: Write failing backup tests**

Assert deterministic versioned JSON, complete tennis/comments data, `null`/`0` preservation, and absence of keys/settings, pending audio, and service-worker state.

- [ ] **Step 2: Write failing import tests**

Assert validation before writes, v0-to-v1 in-memory migration, normalized opponent reconciliation, stable-ID conflict reporting, transactional merge/replace, unchanged current data after invalid input, and import summary counts.

- [ ] **Step 3: Write failing Data Settings tests**

Assert download, upload preview, merge/replace confirmation, clear-all typed confirmation, and secret exclusion messaging.

- [ ] **Step 4: Run tests and verify failure**

Run `npm test -- src/application/backupService.test.ts src/infrastructure/backup src/features/settings/DataSettingsSection.test.tsx`; expect failures.

- [ ] **Step 5: Implement backup/restore and verify round trips**

Apply imports only after preview confirmation and inside repository transactions; produce a timestamped `tennis-stats-backup-v1-YYYY-MM-DD.json` filename.

- [ ] **Step 6: Verify and commit**

Run targeted tests, type checking, and linting; commit `feat: add versioned local backups`.

---

### Task 12: PWA Lifecycle, Offline Safety, and iOS Smoke Guide

**Files:**
- Modify: `vite.config.ts`, `src/main.tsx`, `src/components/AppShell.tsx`
- Create: `public/icons/icon-192.png`, `public/icons/icon-512.png`, `src/components/UpdatePrompt.tsx`, `src/components/ConnectivityBanner.tsx`, associated tests
- Create: `docs/ios-smoke-test.md`

**Interfaces:**
- Produces: installable manifest/service worker scoped to `/tennis-stats/`, explicit update prompt, connectivity status, cached shell with AI endpoints excluded.

- [ ] **Step 1: Write failing lifecycle tests**

Assert offline status, retryable draft messaging, explicit update acceptance (no surprise reload), and that an active recording/draft blocks immediate update activation until safely stored.

- [ ] **Step 2: Run tests and verify failure**

Run `npm test -- src/components/UpdatePrompt.test.tsx src/components/ConnectivityBanner.test.tsx`; expect failures.

- [ ] **Step 3: Configure the PWA and cache exclusions**

Use `registerType: "prompt"`; cache only same-origin application assets/navigation, never provider hosts, request bodies, authorization headers, or API responses.

- [ ] **Step 4: Write the real-iPhone smoke procedure**

Document Safari and iOS Chrome checks for installation, microphone allow/deny, produced MIME type, lock/background interruption, offline manual entry, pending-recording retry, update prompt, and backup download/upload.

- [ ] **Step 5: Verify and commit**

Run `npm run build`, inspect the generated manifest/service worker scope, run component tests/typecheck/lint, and commit `feat: make tennis stats installable offline`.

---

### Task 13: Critical Playwright Journeys

**Files:**
- Create: `tests/e2e/fixtures.ts`, `start-match.spec.ts`, `manual-match.spec.ts`, `voice-draft.spec.ts`, `history-dashboard.spec.ts`, `backup-migration.spec.ts`, `offline-pwa.spec.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Produces: deterministic IndexedDB seeds, fake microphone/audio input, mocked OpenAI/Anthropic routes, and a critical smoke project runnable against the production build in Chromium and WebKit.

- [ ] **Step 1: Build deterministic E2E fixtures**

Provide helpers `seedDatabase(page, snapshot)`, `mockAi(page, scenario)`, `installFakeMicrophone(page)`, and `readDatabase(page)`; assert fixtures contain no real key-shaped strings.

- [ ] **Step 2: Add failing critical journeys**

Cover all 14 E2E journeys listed in the spec, with separate assertions for duplicate voice confirmation after reload, unknown-versus-zero backup/dashboard behavior, conflict review after early-game correction, provider secret redaction, and iOS/WebKit microphone fallback to manual entry.

- [ ] **Step 3: Run each spec while writing it**

Run `npm run test:e2e -- tests/e2e/<spec>.spec.ts --project=chromium`; each new test must fail for the intended assertion before any required production fix, then pass after the minimal fix.

- [ ] **Step 4: Run the cross-browser smoke subset**

Run `npm run test:e2e -- --grep @smoke --project=chromium --project=webkit`; expect zero failures.

- [ ] **Step 5: Commit**

Run `git add tests playwright.config.ts src && git commit -m "test: cover critical tennis journeys"`.

---

### Task 14: CI, GitHub Pages Deployment, and Release Verification

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/pages.yml`
- Modify: `README.md`, `package.json`

**Interfaces:**
- Produces: required CI checks on pushes/PRs and Pages deployment only from `develop` after checks pass.

- [ ] **Step 1: Write CI workflow checks**

On pull requests and pushes, use Node 22 with `npm ci`, run `npx playwright install --with-deps chromium webkit`, then run typecheck, lint, unit/integration tests, production build, and Playwright smoke. Upload Playwright artifacts only on failure.

- [ ] **Step 2: Write Pages workflow**

Trigger on successful CI for `develop` (plus manual dispatch), upload `dist`, and deploy with GitHub's Pages actions and least-privilege permissions. Do not deploy a failing commit.

- [ ] **Step 3: Document local and deployment workflows**

In `README.md`, document setup, scripts, GitHub Pages URL, local-only data/key warning, backup recommendation, and the iPhone smoke-test link without including credentials.

- [ ] **Step 4: Run the complete local release gate**

Run `npm ci && npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e -- --grep @smoke --project=chromium --project=webkit`; expect all commands to exit 0.

- [ ] **Step 5: Inspect secrets and generated assets**

Run repository searches for `sk-`, `Authorization: Bearer`, and known test sentinel values; expect no real credentials. Confirm `dist/manifest.webmanifest`, asset URLs, and service-worker scope use `/tennis-stats/`.

- [ ] **Step 6: Commit and push the delivery configuration**

Commit `ci: deploy verified app to github pages`, push `develop`, verify GitHub Actions succeeds, and verify `https://js-headquaters.github.io/tennis-stats/` loads and can navigate/reload hash routes under the subpath.

---

## Implementation Completion Gate

Before calling the project complete:

- Run the Task 14 full release command from a clean `npm ci` install.
- Complete `docs/ios-smoke-test.md` on an iPhone in both Safari and Chrome; record browser/iOS versions and results.
- Export a populated backup, clear/replace local data, import it, and compare match/game/stat counts.
- Confirm no API key appears in repository history, built assets, browser console output, exported backup, service-worker cache, or test artifacts.
- Confirm GitHub Pages deploys only the verified `develop` artifact and direct/reloaded hash routes work at `/tennis-stats/`.

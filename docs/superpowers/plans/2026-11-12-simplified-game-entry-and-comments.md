# Simplified Game Entry and Voice Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make high-level game statistics and per-game comments the default input while preserving optional detailed errors, old data, and strict voice review.

**Architecture:** Extend the normal-game and voice-draft domain shapes with nullable `unforcedErrors` and `comments`, then centralize effective-unforced-error fallback in the statistics domain. Upgrade local data and backup files explicitly, and reuse a simplified-first editor for manual and voice review while leaving tie-break entry and manual match comments unchanged.

**Tech Stack:** React 19, TypeScript 6, Zod 4, Dexie 4/IndexedDB, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-simplified-game-entry-and-comments-design.md`

## Global Constraints

- `unforcedErrors` and game `comments` are nullable; unknown is `null`, and explicitly recorded zero is `0`.
- Effective unforced errors use the explicit total first, otherwise the partial sum of net/wide/long, and remain unknown when all four sources are null.
- Explicit total and detailed sum may differ; retain both without warnings or automatic correction.
- Keep persisted/internal `failedReturns`; label it **Receive errors** in simplified UI and voice instructions.
- Double faults apply only to player service; receive errors apply only to opponent service.
- Manual and voice review show high-level fields first; net/wide/long live behind an accessible **Add details** disclosure.
- Voice parses comments for specific games only; the existing general match comment remains manually editable and voice confirmation never changes it.
- Existing games, detailed metrics, match comments, recordings, and transcripts must not be lost or overwritten by migration/import.
- AI output remains strictly validated and nothing enters a match before explicit confirmation.
- Tie-break fields and dashboard inclusion remain unchanged.
- Interactive targets stay at least 44×44 CSS pixels; unknown and zero remain visually and accessibly distinct.

## Review Focus

- A game with explicit `unforcedErrors: 0` and nonzero details must display/count zero; Task 1 pins precedence.
- A game with one known detailed component and two null components must use a partial sum, while all-null stays unknown; Task 1 pins both cases.
- Switching server after typing a serve-specific value must clear only the now-inapplicable field and retain total, details, and comment; Task 3 pins this interaction.
- A 10,001-character game comment from manual entry, parser output, backup import, or draft editing must be rejected without partial persistence; Tasks 1, 2, and 4 pin each boundary.
- A multi-game voice draft must retain each comment on its own game through refinement, manual review edits, confirmation, and reload; Tasks 4 and 5 pin the complete path.

---

## File Structure

- `src/domain/model.ts` — authoritative persisted and draft shapes/version literals.
- `src/domain/validation.ts` — game metric/comment validation and comment normalization.
- `src/domain/statistics.ts` — effective unforced-error resolution and high-level averages.
- `src/application/matchService.ts` — normalize and persist new fields during add/edit.
- `src/infrastructure/db/migrations.ts` — data version 2→3 normalization for games and drafts.
- `src/application/backupService.ts` — backup v2 export plus v0/v1 import normalization.
- `src/features/matches/GameForm.tsx` — simplified-first manual editor.
- `src/features/matches/GameCard.tsx` — high-level display, derived marker, optional detail/comment display.
- `src/features/matches/MatchAverages.tsx` — high-level match summary with Receive errors copy.
- `src/infrastructure/ai/{schemas,parserCommon}.ts` — strict parsed-draft v2 contract and prompt.
- `src/application/draftService.ts` — validate/edit/confirm v2 draft games.
- `src/features/voice/DraftGameCard.tsx` — simplified-first voice review editor.
- Existing unit, component, migration, backup, provider, and Playwright fixtures/tests — regression and end-to-end coverage.

### Task 1: Domain Model, Resolution, and Game Services

**Files:**
- Modify: `src/domain/model.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/domain/validation.test.ts`
- Modify: `src/domain/statistics.ts`
- Modify: `src/domain/statistics.test.ts`
- Modify: `src/application/matchService.ts`
- Modify: `src/application/matchService.test.ts`
- Modify: fixture literals in `src/domain/scoring.test.ts`, `src/application/draftService.test.ts`, `src/application/backupService.test.ts`, and `tests/e2e/fixtures.ts`

**Interfaces:**
- Produces: `Game.unforcedErrors: number | null`, `Game.comments: string | null`, and matching `DraftGame` properties.
- Produces: `GAME_COMMENT_MAX_LENGTH = 10_000` and `normalizeGameComment(value: string | null): string | null` in `validation.ts`.
- Produces: `effectiveUnforcedErrors(game: Pick<Game, 'unforcedErrors' | 'netErrors' | 'wideErrors' | 'longErrors'>): number | null` in `statistics.ts`.
- Produces: `GameInput` and `GamePatch` support both new fields.

- [ ] **Step 1: Write failing domain and service tests**

Add tests asserting:

```ts
expect(effectiveUnforcedErrors(game({ unforcedErrors: 0, netErrors: 4 }))).toBe(0);
expect(effectiveUnforcedErrors(game({ unforcedErrors: null, netErrors: 2, wideErrors: null, longErrors: 1 }))).toBe(3);
expect(effectiveUnforcedErrors(game({ unforcedErrors: null, netErrors: null, wideErrors: null, longErrors: null }))).toBeNull();
```

Also assert that add/update trim a nonblank game comment, convert whitespace-only to null, retain mismatching explicit/detail values, and reject a 10,001-character comment without saving. Update existing test factories with null defaults.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/domain/validation.test.ts src/domain/statistics.test.ts src/application/matchService.test.ts`

Expected: FAIL because the fields/helper and service support do not exist.

- [ ] **Step 3: Implement the domain and service interfaces**

Advance `ParsedDraft`/`VoiceDraft` version literals only in Task 4; in this task add the new game properties, validation/normalization, effective resolution, and add/update allowlists. Update `calculateMetric(..., 'unforcedErrors')` to call `effectiveUnforcedErrors` and keep serve eligibility unchanged.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- src/domain/validation.test.ts src/domain/statistics.test.ts src/application/matchService.test.ts src/domain/scoring.test.ts && npm run typecheck`

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/application/matchService.ts src/application/matchService.test.ts src/application/draftService.test.ts src/application/backupService.test.ts tests/e2e/fixtures.ts
git commit -m "feat: add high-level game stats and comments"
```

### Task 2: Local Data and Backup Migration

**Files:**
- Modify: `src/infrastructure/db/migrations.ts`
- Modify: `src/infrastructure/db/migrations.test.ts`
- Modify: `src/application/backupService.ts`
- Modify: `src/application/backupService.test.ts`
- Modify: `tests/e2e/backup-migration.spec.ts`

**Interfaces:**
- Consumes: new `Game` properties and `GAME_COMMENT_MAX_LENGTH` from Task 1.
- Produces: `DATA_VERSION = 3` with idempotent 2→3 migration.
- Produces: backup `version: 2`; import preview accepts source versions `0 | 1 | 2` and returns current normalized `TennisRecords`.

- [ ] **Step 1: Write failing migration and backup tests**

Add a version-2 database fixture containing a detailed game and a rich parsed-draft-v1 game. Assert migration preserves every old field, adds `unforcedErrors: null` and `comments: null`, upgrades the draft shape to the v2 contract defined by Task 4 (`version: 2`, new fields null), and is unchanged on a second run.

Add backup assertions that v2 export includes the new keys in canonical order; v1 import normalizes them to null; v2 round-trip preserves null, zero, comments, and a total that differs from details; a 10,001-character comment is rejected. Keep v0 coverage.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- src/infrastructure/db/migrations.test.ts src/application/backupService.test.ts`

Expected: FAIL on data/backup versions and absent normalization.

- [ ] **Step 3: Implement migration and backup v2**

Add an idempotent 2→3 migration over `games` and `drafts`; do not change Dexie indexes. Add separate v1 and v2 game schemas: v1 has the old strict keys and migrates new fields to null, while v2 requires both new keys. Export only v2 and update supported-version/file-name copy.

- [ ] **Step 4: Run persistence tests**

Run: `npm test -- src/infrastructure/db/migrations.test.ts src/infrastructure/db/repositories.test.ts src/application/backupService.test.ts && npm run typecheck`

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/db src/application/backupService.ts src/application/backupService.test.ts tests/e2e/backup-migration.spec.ts
git commit -m "feat: migrate game totals and comments"
```

### Task 3: Simplified Manual Entry and Match Display

**Files:**
- Modify: `src/features/matches/GameForm.tsx`
- Modify: `src/features/matches/GameCard.tsx`
- Modify: `src/features/matches/GameCard.test.tsx`
- Modify: `src/features/matches/MatchAverages.tsx`
- Modify: `src/features/matches/MatchDetailsPage.test.tsx`
- Modify: `src/features/matches/ActiveMatchPage.test.tsx`
- Modify: `src/styles/global.css`
- Modify: `src/styles/touchTargets.test.tsx`

**Interfaces:**
- Consumes: `effectiveUnforcedErrors`, `GameInput`, `GamePatch`, and new game fields from Task 1.
- Produces: `GameForm` with default high-level fields and native `<details><summary>Add details</summary>` disclosure.
- Produces: game cards and match averages that present Unforced errors, Double faults, and Receive errors first.

- [ ] **Step 1: Write failing component tests**

Assert the add form initially shows Unforced errors, the applicable Double faults/Receive errors field, and Game comment; net/wide/long are inside collapsed **Add details**. Assert editing an existing game with any detail automatically opens the disclosure. Assert server switching clears only the now-inapplicable field and preserves total, detail, and comment. Assert submit emits trimmed comment and all high/detail values.

Assert `GameCard` shows the authoritative explicit total, labels fallback as “Derived from details,” renders a per-game comment, and exposes detailed values without removing them. Assert match averages have exactly the three high-level rows and use **Receive errors**.

- [ ] **Step 2: Run component tests and verify failure**

Run: `npm test -- src/features/matches/GameCard.test.tsx src/features/matches/ActiveMatchPage.test.tsx src/features/matches/MatchDetailsPage.test.tsx src/styles/touchTargets.test.tsx`

Expected: FAIL because simplified fields/disclosure/comments are absent.

- [ ] **Step 3: Implement simplified-first manual UI**

Keep Result, Server, and optional scores. Render only the applicable serve metric instead of a disabled irrelevant input. Use `details` for optional net/wide/long, open by default when editing a game with any non-null detail. Preserve the existing match-comments forms unchanged.

- [ ] **Step 4: Run match UI tests**

Run: `npm test -- src/features/matches src/styles/touchTargets.test.tsx && npm run typecheck`

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/matches src/styles
git commit -m "feat: simplify manual game entry"
```

### Task 4: Voice Parsing, Draft Editing, and Confirmation

**Files:**
- Modify: `src/domain/model.ts`
- Modify: `src/infrastructure/ai/schemas.ts`
- Modify: `src/infrastructure/ai/parserCommon.ts`
- Modify: `src/infrastructure/ai/providers.test.ts`
- Modify: `src/application/draftService.ts`
- Modify: `src/application/draftService.test.ts`
- Modify: `src/features/voice/DraftGameCard.tsx`
- Modify: `src/features/voice/DraftGameCard.test.tsx`
- Modify: `src/features/voice/DraftReviewPage.test.tsx`
- Modify: `tests/e2e/fixtures.ts`

**Interfaces:**
- Consumes: new fields, normalization, limits, and game-service confirmation support from Tasks 1–2.
- Produces: `ParsedDraft.version: 2` and `VoiceDraft.dataVersion: 2`.
- Produces: strict draft game shape `{ server, result, unforcedErrors, netErrors, wideErrors, longErrors, doubleFaults, failedReturns, comments }`.

- [ ] **Step 1: Write failing parser/service tests**

Update provider contract tests to require version 2 and all exact keys. Assert the prompt calls `failedReturns` **Receive errors**, directs per-game comment attachment, permits explicit totals plus details, and says to warn instead of guessing ambiguous ownership. Reject extra keys, missing keys, inapplicable serve metrics, negative/fractional totals, and comments over 10,000 characters.

Add draft-service tests that manual draft edits update/trim comments and totals, whitespace becomes null, invalid length makes no write, refinement preserves per-game comments, and confirmation writes each comment/stat to the correct game without changing `match.comments`.

- [ ] **Step 2: Run voice unit tests and verify failure**

Run: `npm test -- src/infrastructure/ai/providers.test.ts src/application/draftService.test.ts src/features/voice/DraftGameCard.test.tsx src/features/voice/DraftReviewPage.test.tsx`

Expected: FAIL because parser v2 and the new draft editor fields are absent.

- [ ] **Step 3: Implement strict voice v2 and simplified draft editor**

Use the same high-level-first layout and **Add details** disclosure as Task 3. Extend the draft patch allowlist and strict local Zod schemas. Keep confirmation disabled for zero-game drafts and keep match comments outside parser payload/output.

- [ ] **Step 4: Run voice tests and typecheck**

Run: `npm test -- src/infrastructure/ai src/application/draftService.test.ts src/features/voice && npm run typecheck`

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/model.ts src/infrastructure/ai src/application/draftService.ts src/application/draftService.test.ts src/features/voice tests/e2e/fixtures.ts
git commit -m "feat: parse voice game totals and comments"
```

### Task 5: Mobile Journeys and Full Regression Verification

**Files:**
- Modify: `tests/e2e/manual-match.spec.ts`
- Modify: `tests/e2e/voice-draft.spec.ts`
- Modify: `tests/e2e/history-dashboard.spec.ts`
- Modify: `tests/e2e/backup-migration.spec.ts`

**Interfaces:**
- Consumes: completed manual, voice, migration, and dashboard behavior from Tasks 1–4.
- Produces: browser-level regression coverage for the shipped workflow.

- [ ] **Step 1: Add failing end-to-end assertions**

Extend the manual journey to add a game with an explicit total, applicable serve metric, comment, and no details; then edit it to add net/wide/long while retaining the original total/comment. Extend the voice journey to parse at least two games with different comments, manually edit one comment, refine the draft, reload review, confirm once, and assert comments remain attached to their own games while the general match comment is unchanged.

Extend dashboard coverage with one explicit total that differs from details and one legacy details-only game; assert the average uses the explicit total for the first and fallback sum for the second. Keep backup migration browser coverage aligned with versions 1 and 2.

- [ ] **Step 2: Run affected Chromium journeys and verify failure**

Run: `npx playwright test tests/e2e/manual-match.spec.ts tests/e2e/voice-draft.spec.ts tests/e2e/history-dashboard.spec.ts tests/e2e/backup-migration.spec.ts --project=chromium`

Expected before final fixture/UI alignment: one or more new assertions FAIL.

- [ ] **Step 3: Make only integration/fixture corrections required by the journeys**

Do not add new product behavior here; route product defects back to the owning implementation before accepting this task.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa
npm run test:e2e
```

Expected: every command exits 0; Playwright may retain only pre-existing intentional skips.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e
git commit -m "test: cover simplified game recording"
```

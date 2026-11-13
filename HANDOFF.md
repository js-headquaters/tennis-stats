# HANDOFF — Simplified game entry, high-level stats, and voice game comments

Date: 2026-11-13
Repo: `js-headquaters/tennis-stats`
Live: https://js-headquaters.github.io/tennis-stats/

## Where the work is

- Primary working directory: `/Users/vlads/.local/share/opencode/worktree/180db9/dashboard-error-summary`
- Git state: **detached HEAD at `136e319`** (`docs: complete dashboard and icon improvements`)
- `develop` is at `b0ee375`; the worktree is one commit ahead of it (`136e319`), so it is not merged yet.
- Main checkout: `/Users/vlads/git/tennis-stats` on `develop`
- Uncommitted files (both new, untracked):
  - `docs/superpowers/specs/2026-11-12-simplified-game-entry-and-comments-design.md`
  - `docs/superpowers/plans/2026-11-12-simplified-game-entry-and-comments.md`

**No product code has been written for this request yet.** Only the design and plan exist.

Before continuing, create/switch to a real branch in this worktree (e.g. `feature/simplified-game-entry`) instead of working detached, and commit the two docs.

## The request

The user finds current game entry too complex to think about during play. They want:

1. **Simplified mode** for each game: total **Unforced errors**, **Double faults**, and **Receive errors** only.
2. **Per-game comments** from voice recognition, shown with that game at the end.
3. **Match-level comments stay** and remain manually editable during/after the match.
4. **Detailed net/wide/long stats preserved**, but optional behind “Add details”.
5. Dashboard rule: use an explicitly recorded game total when present; otherwise derive from net + wide + long; if neither exists, unknown.
6. Voice parses statistics **and per-game comments**; it does **not** parse general match comments (the user explicitly rejected that unnecessary addition).
7. Migrate existing data safely without inventing totals.

## Decisions already made with the user

- **Approach 1 selected:** explicit `unforcedErrors` total stored independently from net/wide/long. The total is authoritative even if it differs from the detailed sum. No auto-sync, no redistribution.
- Simplified-first UI, detailed fields behind an accessible **Add details** disclosure.
- Missing components in a partial breakdown count as zero; all-null statistics remain unknown (`null`), not zero.
- `failedReturns` remains the persisted field name; user-facing simplified label is **Receive errors**.
- General match comments are manual only during this change. Voice confirmation must not alter `match.comments`.
- Voice still requires review and explicit confirmation before games enter a match.
- Existing specs/plans under `docs/superpowers/` are the pattern to follow.

## Documents to read first

1. `docs/superpowers/specs/2026-11-12-simplified-game-entry-and-comments-design.md` — binding design.
2. `docs/superpowers/plans/2026-11-12-simplified-game-entry-and-comments.md` — five-task plan.
3. Prior context: `docs/superpowers/specs/2026-11-11-tennis-stats-design.md`.

The plan has **not** had its formal self-review or an independent pre-flight review yet. Review it against the spec before dispatching implementation, especially the version/migration details below.

## Execution method the user requested

Use the Superpowers **`subagent-driven-development`** skill:

- One fresh implementer subagent per plan task.
- Task review (spec compliance + code quality) after every task.
- Fix loop for Critical/Important findings.
- Whole-branch final review on the most capable available model.
- Then `finishing-a-development-branch`.
- Do not stop between tasks for check-ins; record rulings in the SDD ledger.
- Commits/push/deploy are side-effecting: get explicit approval before pushing/deploying.

## Plan summary

1. **Task 1 — Domain model, resolution, game services**
   - Add nullable `unforcedErrors` and `comments` to `Game` and `DraftGame`.
   - Add `effectiveUnforcedErrors()` precedence/fallback in `src/domain/statistics.ts`.
   - Add `GAME_COMMENT_MAX_LENGTH = 10_000` and `normalizeGameComment()` in `src/domain/validation.ts`.
   - Extend `GameInput`, `GamePatch`, add/edit allowlists and validation.
   - Update all typed fixtures.
2. **Task 2 — Local data and backup migration**
   - Bump `DATA_VERSION` from **2 to 3** with an idempotent 2→3 game/draft normalization.
   - Add `unforcedErrors: null`, `comments: null` where absent; never overwrite existing values.
   - Upgrade parsed drafts to version 2 with null new fields.
   - Bump backup file format from **v1 to v2**; import must accept v0, v1, and v2.
   - Preserve strict per-version schemas; canonical export key order must include new fields.
3. **Task 3 — Simplified manual entry and display**
   - `GameForm`: high-level fields first, applicable serve metric only, optional score, game comment, native `<details>` for net/wide/long.
   - Open details automatically when editing a game with any detailed value.
   - `GameCard`: show effective unforced errors, derived marker, game comment, details available.
   - `MatchAverages`: exactly three high-level rows with **Receive errors** copy.
   - Keep match-comments editors untouched.
4. **Task 4 — Voice parsing, draft editing, confirmation**
   - `ParsedDraft.version: 2`, `VoiceDraft.dataVersion: 2`.
   - Strict schema per game: `server`, `result`, `unforcedErrors`, `netErrors`, `wideErrors`, `longErrors`, `doubleFaults`, `failedReturns`, `comments`.
   - Prompt must define **Receive errors** = `failedReturns`, per-game comment ownership, explicit total vs optional details, and “warn, don’t guess” for ambiguity.
   - `DraftGameCard`: same simplified-first layout; comments editable.
   - Draft confirmation writes each game’s stats/comment to that game only; blocks zero-game drafts.
5. **Task 5 — Mobile journeys and full regression**
   - Manual journey with total + comment, then add details while retaining the total.
   - Voice journey with multiple games/comments, manual comment edit, refinement, reload, confirm once.
   - Dashboard with explicit total differing from details plus a legacy details-only game.
   - Run full verification and commit.

## Key code locations

- Domain shapes: `src/domain/model.ts` (`Game`, `DraftGame`, `ParsedDraft`, `VoiceDraft`)
- Validation: `src/domain/validation.ts`
- Statistics/fallback: `src/domain/statistics.ts` (`calculateMetric`, `DASHBOARD_METRICS`)
- Add/edit services: `src/application/matchService.ts` (`GameInput`, `prepareGames`, `GamePatch`, `updateGame`, allowlists around lines 48, 162, 235)
- Manual form: `src/features/matches/GameForm.tsx`
- Shared metric labels: `src/features/matches/GameCard.tsx` (`metrics`; also used by `DraftGameCard.tsx`)
- Voice parser contract: `src/infrastructure/ai/schemas.ts`, `src/infrastructure/ai/parserCommon.ts`
- Draft lifecycle: `src/application/draftService.ts` (`gameSchema`, `updateDraftGame`, `performConfirmation`)
- Voice review UI: `src/features/voice/DraftGameCard.tsx`, `DraftReviewPage.tsx`
- DB migration: `src/infrastructure/db/migrations.ts` (`DATA_VERSION = 2`)
- Backup: `src/application/backupService.ts` (`BACKUP_VERSION = 1`, strict v0/v1 schemas, canonical key order)
- E2E builders: `tests/e2e/fixtures.ts` (`buildGame`, `buildDraftGame`, `buildSnapshot`)
- Relevant tests: `statistics.test.ts`, `validation.test.ts`, `matchService.test.ts`, `draftService.test.ts`, `backupService.test.ts`, `migrations.test.ts`, provider tests, feature component tests, Playwright journeys.

## Migration/import pitfalls to keep in view

- `VoiceDraft.dataVersion` and `ParsedDraft.version` are currently literal `1`. Changing them touches migration, repositories, fixtures, and every parser mock. Do it once in Task 2/4 consistently.
- Backup v1 schema is **strict**, so it will reject new fields. Keep a v1 schema that normalizes new fields to null and a v2 schema that requires them.
- `canonical.games` in `backupService.ts` fixes key order; add `unforcedErrors` and `comments` there.
- `gameIssues()` in `backupService.ts` already validates metrics; extend it for totals/comments.
- Do not backfill `unforcedErrors` during migration. Null is the signal to use the detail fallback.
- Existing `comment` max length is 10,000; reuse it for game comments.
- Tie-breaks are separate entities and have no unforced-error total or comment in this change.
- Dashboard currently calls `calculateMetric(..., 'unforcedErrors')`; route it through the new resolver so behavior stays consistent.

## Verification commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa
npm run test:e2e
```

Suggested focused runs while implementing:

```bash
npm test -- src/domain/statistics.test.ts src/domain/validation.test.ts
npm test -- src/infrastructure/db/migrations.test.ts src/application/backupService.test.ts
npm test -- src/features/matches src/features/voice
npx playwright test tests/e2e/manual-match.spec.ts tests/e2e/voice-draft.spec.ts tests/e2e/history-dashboard.spec.ts --project=chromium
```

Previous baseline before this change: 544 unit tests, 103 Playwright tests with one intentional skip. Counts will grow.

## Deployment (after approval only)

1. Finish and review the branch.
2. Fast-forward/merge into `develop`.
3. Push to `js-headquaters/tennis-stats`.
4. GitHub Actions CI + Pages deploy on `develop`.
5. Smoke-test the live site, including a reload with the PWA to confirm the new service-worker content.

## Known environment notes

- macOS; Playwright voice tests use persistent browser contexts because ephemeral WebKit rejects Blob storage in IndexedDB.
- The app is a static PWA under `/tennis-stats/` on GitHub Pages.
- `/Users/vlads/git/tennis-stats/HANDOFF.md` exists untracked in the main checkout; do not delete or overwrite it.
- Superseded icon/dashboard work is already merged/deployed; do not redo it.
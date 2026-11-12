# Task 2: Domain Model and Validation

## Implemented
- Added framework-free model contracts in `src/domain/model.ts`: `Opponent`, `Match`, `TennisSet`, `Game`, `TieBreak`, `VoiceDraft`, `MatchBundle`, `DatabaseSnapshot`, `RecordedMetric`, `Server`, `MatchFormat`, `MatchStatus`, `ValidationIssue`, and discriminated `ValidationResult<T>`.
- Persisted entity identifiers and timestamps are strings. Ordered children use `ordinal`; game scores are optional nullable score pairs; each metric is `number | null`.
- Added `normalizeOpponentName` (trims whitespace) and `validateGame` (checks stable non-empty identifying strings, integer-or-null metrics, and service-dependent metric rules).
- `null` is retained and explicit zero is valid.

## TDD and verification
- RED: `npm test -- src/domain/validation.test.ts` failed as expected because `./validation` did not yet exist (unresolved import).
- GREEN: `npm test -- src/domain/validation.test.ts` — 1 file, 6 tests passed.
- `npm run typecheck` — passed.
- `npm test` — 2 files, 8 tests passed.

## Files changed
- `src/domain/model.ts`
- `src/domain/validation.ts`
- `src/domain/validation.test.ts`

## Self-review / concerns
- Confirmed validator preserves the original valid input, including explicit zero values, and enforces both cross-field service restrictions.
- No React, Dexie, provider, or browser API imports in the domain layer.
- No known concerns.

## Fix round 1

### What changed
- `validateGame` now rejects runtime `server` values outside `'player' | 'opponent'`, negative/non-integer `ordinal` values, and non-null scores that are not a pair of allowed point strings. Issues identify `server`, `ordinal`, or `score` and describe the accepted value.
- Added runtime-malformed fixture cases plus ordinal/score boundary acceptance tests to `src/domain/validation.test.ts`.

### TDD and verification
- RED command: `npm test -- src/domain/validation.test.ts` — failed as expected: 10 tests failed, 8 passed. Invalid servers, ordinals, and malformed scores returned `{ ok: true }`.
- GREEN targeted: `npm test -- src/domain/validation.test.ts` — 1 file, 18 tests passed.
- `npm run typecheck` — passed.
- `npm test` — 2 files, 20 tests passed.

### Files changed
- `src/domain/validation.test.ts`
- `src/domain/validation.ts`
- `.superpowers/sdd/2026-11-11-tennis-stats-pwa/task-2-report.md`

### Self-review
- Validation enforces exactly the reviewed Game field invariants, including allowed boundary ordinal zero and allowed score point strings. Unknown servers now fail validation, preventing them from bypassing service-dependent rules.
- No scoring consistency logic or unrelated model, persistence, or UI changes were added. No concerns identified.

## Fix round 2

### Exact model corrections
- `MatchFormat` is now exactly `twoSetsSuperTiebreak | openPractice | oneSet | bestOfThree`; `MatchStatus` is exactly `active | completed | abandoned`.
- `RecordedMetric` and `Game` now contain only `netErrors`, `wideErrors`, `longErrors`, `doubleFaults`, and `failedReturns` (all nullable numbers). `Game.result` is required as `won | lost`.
- `Opponent` includes `name` and `normalizedName`; `Match` includes opponent, played timestamp, exact format, first server, status, nullable comments and persisted timestamps. `TennisSet` models ordinal/kind/status/tie-break relation without duplicated scores. `TieBreak` models kind, final points and nullable error aggregates without ordinal.
- Kept `VoiceDraft`, `MatchBundle`, and `DatabaseSnapshot` minimal; snapshot and draft retain numeric `dataVersion`.
- Updated `validateGame` to validate only the exact five metrics while preserving runtime server, ordinal, score, and service-specific checks.

### TDD and verification
- RED: `npm test -- src/domain/validation.test.ts` — 1 file failed, 4 tests failed / 17 passed; validator rejected valid new-form fixtures because it still checked removed metrics. This exposed the model/validator mismatch.
- GREEN targeted: `npm test -- src/domain/validation.test.ts` — 1 file, 21 tests passed.
- `npm run typecheck` — passed.
- `npm test` — 2 files, 23 tests passed.
- `npm run lint` — passed.

### Files changed
- `src/domain/model.ts`
- `src/domain/validation.ts`
- `src/domain/validation.test.ts`
- `.superpowers/sdd/2026-11-11-tennis-stats-pwa/task-2-report.md`

### Self-review
- Type-level fixtures pin exact match format/status unions, Game result, set kind/status unions, tie-break kinds and metric fields. Runtime fixture asserts only the five tracked Game metrics. Explicit zero values and prior runtime checks remain covered.
- No scoring implementation, persistence, or UI added. No concerns identified.

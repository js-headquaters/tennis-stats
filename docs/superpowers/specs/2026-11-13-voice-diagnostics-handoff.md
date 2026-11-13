# Voice recognition diagnostics — handoff (2026-11-13)

## Where the work is

- Worktree: `/Users/vlads/.local/share/opencode/worktree/180db9/voice-diagnostics`
- Branch: `voice-diagnostics` (created from `develop` at `b0ee375`)
- Baseline: `npm install` done, `npm test` passes (40 files, 544 tests)
- No product code has been changed yet. Only this handoff file is new.
- The main checkout at `/Users/vlads/git/tennis-stats` is untouched.

## Goal (from the user)

The user had a day of many OpenAI voice-recognition failures. They want the app to
record enough evidence to diagnose those failures later:

1. Log every transcription and parser attempt, including every retry and every error.
2. Store the logs **with the match**, surviving draft confirmation and draft discard.
3. Let the user **download the logs from the match** later, as a file they can hand
   to an AI for analysis.
4. Log content: **transcription text, raw provider responses, role responses,
   timestamps, provider/model names, and whatever errors occurred.**
5. Explicitly **no audio** in the diagnostics.
6. The eventual purpose is to improve prompts/parsing so OpenAI recognition produces
   fewer errors.

The user was explicit: *"I want you to keep all errors so I can analyze all of that in
the end. Normally, I'm going to retry a few times and each error. I want you to log it."*

## Decisions already made with the user

- **Approach 1 was chosen** ("use recommended"): a dedicated match-scoped diagnostics
  table in IndexedDB. Not embedded in the match record, not retained voice drafts.
- Diagnostics are **independent of draft lifecycle**. Every attempt is kept even if the
  draft is confirmed or discarded.
- Diagnostics are deleted only when the **match** is deleted.
- The download is a **JSON file offered from Match Details**.
- **Audio is not included.**
- API keys and authorization headers must never be written to diagnostics.

## What the code does today (verified in this worktree)

### Data layer

- `src/domain/model.ts`
  - `VoiceDraft` already has `transcripts[]`, `parsedDraft`, `state`, and a sanitized
    `error { code, message, phase }`. This is the only current voice audit trail.
  - `DatabaseSnapshot` contains tennis records plus `voiceDrafts`.
- `src/infrastructure/db/schema.ts`
  - Dexie schema version 1, tables: `opponents`, `matches`, `sets`, `games`,
    `tieBreaks`, `drafts`, `metadata`.
  - Any new table needs a new Dexie `version(...).stores(...)` block.
- `src/infrastructure/db/migrations.ts`
  - `DATA_VERSION = 2`; migrations are keyed `0` and `1`; `runDataMigrations` writes
    `metadata.dataVersion`. A new table/index needs `DATA_VERSION = 3` and a `2` entry
    (likely a no-op) or the app's data-version gate will not advance.
- `src/infrastructure/db/repositories.ts`
  - `confirmDraft` deletes the draft (`this.db.drafts.delete(draftId)`), which is exactly
    why diagnostics must be separate.
  - `deleteMatch` deletes match children and drafts by `matchId`; diagnostics must be
    deleted there too.
  - `replaceAll` clears `this.db.tables` (so a new table is cleared automatically) but
    validates and bulk-adds each table explicitly. `snapshot()` also enumerates tables
    explicitly. Both need updating if diagnostics enter the snapshot type.
  - `insertRecords` inserts only tennis records.
- `src/application/backupService.ts`
  - Backups intentionally exclude drafts and recordings. Current decision pending:
    diagnostics should probably also be excluded from backup files (privacy/size), but
    this needs a line in the design.

### Provider layer

- `src/application/ports.ts`
  - `TranscriptionProvider.transcribe(request, signal)` returns `{ text, provider, model }`.
  - `StatisticsParser.parse(request, signal)` returns a `ParsedDraft`.
  - Neither interface exposes raw responses or error details beyond a safe code.
- `src/infrastructure/ai/openAiTranscription.ts`
  - Returns response `text` only; the rest of the JSON body is dropped.
- `src/infrastructure/ai/openAiParser.ts` and `anthropicParser.ts`
  - Extract content text, `parseDraft(...)`, and throw `SafeProviderError('invalid-response')`
    on failure. Raw model content of a failed parse is currently lost.
- `src/infrastructure/ai/common.ts`
  - `requestJson` discards non-OK response bodies and maps status to
    `auth | rate | network`. `redactProviderError` replaces unknown errors with `network`.
  - The user wants "whatever errors"; capturing sanitized HTTP status and a bounded
    response-body excerpt will require deliberate changes here. Do not copy headers or
    request bodies containing `Authorization` / `x-api-key`.
- `src/infrastructure/ai/parserCommon.ts`
  - `instruction` and `requestPayload`; the parser request context is deliberately minimal.

### Draft processing

- `src/application/draftService.ts` — the central place to instrument.
  - `process(draft, phase, signal)` handles offline early-return, then one transcription
    call and one parser call via `bounded(...)`.
  - `providerFailure(error, phase)` maps failures to fixed messages and saves
    `state: 'waiting-retry'`. Retries call `retryDraft`, which re-runs the failed phase.
  - Cancellation/timeout are represented as `{ code: 'cancelled' | 'timeout' }`.
  - `refineDraftWithAudio` replaces the recording and re-runs transcription, so one draft
    can produce multiple transcription and parser attempts.
  - `applyable`/`draftFitsMatch` gate processing but are not relevant to logging.
  - Diagnostics writes must never break draft processing: a failed diagnostics save
    should be swallowed (or surfaced only as a non-blocking note), because losing the
    draft would be worse than losing its log.

### UI

- `src/features/matches/MatchDetailsPage.tsx`
  - Loads a `MatchBundle`, has a `run()` busy lock and a read-only mode check.
  - Best place for a "Voice diagnostics" section and download button.
- `src/features/settings/DataSettingsSection.tsx` shows the established backup download
  pattern; `src/infrastructure/backup/fileTransfer.ts` exposes
  `createBrowserFileTransfer().download(fileName, text)` and is injectable for tests.
- `src/features/voice/RecordPage.tsx` and `DraftReviewPage.tsx` show retry/processing flow.
- Routes live in `src/app/routes.ts`; no new route is needed for a download from Match
  Details.

## Design sketch (not yet written up or approved)

This is the shape to carry into the design document; refine during planning, not by
re-asking decided questions.

1. **Domain entity** — e.g. `MatchDiagnostic`:
   - `id`, `matchId`, `draftId` (nullable), `setId`, `phase: 'transcription' | 'parser'`
   - `provider`, `model`
   - `startedAt`, `finishedAt`
   - `outcome: 'success' | 'error'`
   - `transcript` (transcription text, when available)
   - `response` (raw provider response: transcription JSON text or parser model content)
   - `request` (optional minimal context/transcript sent; keep bounded)
   - `error: { code: string; message: string; status?: number; body?: string } | null`
   - `createdAt`
   - Add size caps to keep IndexedDB and downloads bounded (for example 1 MB of text per
     event and a per-match event cap with explicit truncation markers).

2. **Provider diagnostics capture**
   - Preferred: adapters return the raw payload alongside the parsed result, or accept an
     `onAttempt` callback that receives sanitized `{ phase, provider, model, startedAt,
     finishedAt, response, error }` for both success and failure.
   - `common.ts` needs to retain a bounded, credential-free HTTP status/body excerpt.
     Response bodies may contain user data, so never include headers or request bodies.

3. **Service wiring**
   - In `draftService.process`, write one diagnostics row per provider call (including
     offline, timeout, cancellation and retries). `attempt` numbering can be derived from
     existing rows per draft+phase.
   - Do not delete diagnostics in `confirmDraft`, `discardDraft` or draft migrations.
   - Delete diagnostics in `deleteMatch`; clear them in `replaceAll` (automatic via
     `db.tables`, but keep explicit handling consistent).

4. **Repository/ports**
   - Add `saveDiagnostic`, `listDiagnostics(matchId)` (and optionally `count`).
   - Decide explicitly whether diagnostics belong in `DatabaseSnapshot`/backups. Proposal:
     keep them out of backup files, like drafts, to avoid bloating and leaking transcripts;
     still delete them with the match and clear them on replace-all.
   - If they stay out of backups, `snapshot()`/`replaceAll`/`insertRecords` need only
     table-list updates, not validation changes.

5. **Download**
   - In Match Details, list/count diagnostics and offer "Download voice diagnostics".
   - JSON envelope: `{ format: 'tennis-stats-voice-diagnostics', version: 1,
     exportedAt, match: { id, playedAt, format, opponent? }, diagnostics: [...] }`.
   - Filename: `tennis-stats-voice-diagnostics-<matchId>-YYYY-MM-DD.json`.
   - Use `FileTransfer` so the browser download is mockable in tests.
   - Read-only recovery mode: viewing and downloading must still work.

6. **Tests**
   - Provider adapter tests: raw response and sanitized error capture; API key never
     appears in output.
   - `draftService` tests: one row per attempt, retries append rows, failures/cancel/timeout
     are logged, drafts confirmed/discarded leave rows, diagnostics-save failure does not
     break processing.
   - Repository tests: cascade on `deleteMatch`, snapshot/replace behavior.
   - UI test: Match Details renders count and download triggers `FileTransfer.download`
     with the expected filename and JSON.
   - Migration test: data version advances; existing data untouched.

## Open questions for the design (ask only if still open)

- Should successful attempts be retained too? (User asked for errors and retries; retaining
  successes is needed for "timestamps/models" and for comparing good vs bad recognition.
  Proposal: yes.)
- Per-match retention cap and per-event text cap? (Proposal: cap and mark truncation.)
- Include diagnostics in backup files? (Proposal: no, like drafts.)
- How much HTTP error detail to keep? (Proposal: status + bounded body excerpt, never
  headers/keys; the user explicitly asked for "whatever errors".)

## Next steps

1. Write the design doc at
   `docs/superpowers/specs/2026-11-13-voice-diagnostics-design.md`, including the three
   approaches already discussed (dedicated table chosen), the decisions above, and the
   open questions resolved.
2. Get explicit user approval of that design doc (hard gate — no product code before it).
3. Invoke `writing-plans`, then execute with TDD.
4. Verify with `npm test`, `npm run typecheck`, `npm run lint`.
5. Finish the branch per `finishing-a-development-branch`; the user said they are working
   in another window, so do not merge into `develop` without confirmation.

## Constraints / guardrails

- Never log API keys, `Authorization`, `x-api-key`, or full request headers.
- Diagnostics are match-scoped and must survive draft confirmation/discard.
- No audio in diagnostics.
- Do not change match history/backup semantics without an explicit design decision.
- Keep changes consistent with the existing TS style: small modules, zod validation,
  dependency injection for repository/clock/ids/file transfer, vitest + Testing Library.

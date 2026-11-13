# Voice diagnostics — design (2026-11-13)

Status: draft for user approval. Source requirements: `2026-11-13-voice-diagnostics-handoff.md`.
Items marked **[call]** are my decisions on questions the handoff left open; everything else was decided with the user.

## 1. Why

A day of repeated OpenAI recognition failures left no evidence to analyse: the draft keeps only a sanitised error code and is deleted on confirm/discard; raw provider responses are dropped. The user retries several times and wants every attempt and error kept, attached to the match, downloadable later as a file to hand to an AI, to improve prompts/parsing.

## 2. Goals / non-goals / anti-goals

Goals
- One record per provider call (transcription and parser), including every retry, timeout, cancellation, offline skip and error.
- Records belong to the match and outlive draft confirm/discard; they are deleted only with the match.
- JSON download from Match Details, also in read-only recovery mode.
- Record: transcript text, raw provider response, timestamps, provider/model, outcome, error details.

Non-goals
- No audio. No new route. No in-app log viewer beyond a count and the download button.
- No inclusion in backup files **[call]** (like drafts: privacy and size).
- No change to draft lifecycle, history or backup semantics.

Anti-goals (failure even if it "works")
- Any API key, `Authorization`/`x-api-key` header, or request headers in a record or download.
- A diagnostics write failure breaking or delaying draft processing.
- Unbounded growth of IndexedDB or of the download.

## 3. Approach (chosen with user)

Dedicated match-scoped IndexedDB table `diagnostics`. Rejected: embedding in the match record (bloats every match read), keeping drafts alive (conflicts with draft lifecycle).

## 4. Design

### 4.1 Entity `MatchDiagnostic` (`src/domain/model.ts`, zod schema alongside)
```
id, matchId, setId | null, draftId | null
phase: 'transcription' | 'parser'
attempt: number            // 1-based, per draftId+phase, derived from existing rows
provider, model
startedAt, finishedAt      // ISO, from injected clock
outcome: 'success' | 'error' | 'cancelled' | 'timeout' | 'offline'
transcript: Text | null    // transcription text when available
request: Text | null       // parser only: transcript + ParserMatchContext as already sent (no opponent name, no audio)
response: Text | null      // raw provider body (transcription JSON / parser model content)
error: { code, message, status?: number, body?: Text } | null
```
`Text = { value: string; truncated: boolean; originalLength: number }`.

### 4.2 Caps **[call]**
- 256 KB per `Text` field (error `body` 8 KB); excess is cut and flagged `truncated`.
- 500 rows per match. On overflow delete the oldest `success` rows first, then oldest rows overall — errors are the evidence the user asked for.

### 4.3 Capture in providers
- `TranscriptionProvider.transcribe` and `StatisticsParser.parse` get an optional third argument `trace?: AttemptTrace` (`recordResponse(text)`, `recordHttpError({status, body})`). Return types and existing callers are unchanged.
- `common.ts` `requestJson`: on non-OK, pass status plus bounded body excerpt to the trace before throwing the existing `SafeProviderError`; never touches headers or request body. On parse failure (`invalid-response`) the raw model content is passed to the trace first.
- Trace objects never receive the API key; a test asserts the sentinel key is absent from every stored row.

### 4.4 Service wiring (`draftService.process`)
- Around each `bounded(...)` provider call: build a trace, record `startedAt`, run the call, then write one row in a `finally`-style path covering success, error, timeout, cancellation and the offline early-return. `refineDraftWithAudio` and `retryDraft` go through the same path, so retries append rows.
- Writes are fire-and-forget with errors swallowed (logged to console only); processing result is never altered by them.
- `confirmDraft`, `discardDraft` and draft migrations do not touch diagnostics.

### 4.5 Storage
- Dexie `version(2)` adds `diagnostics: 'id, matchId, draftId, startedAt'`; `DATA_VERSION = 3` with a no-op migration `2`.
- Repository port: `saveDiagnostic`, `listDiagnostics(matchId)`, `countDiagnostics(matchId)`; `deleteMatch` removes rows by `matchId`; `replaceAll` clears them via `db.tables`. Not part of `DatabaseSnapshot`, so `snapshot()`, `insertRecords` and backups are unchanged.

### 4.6 Download
- Match Details shows "Voice diagnostics: N events" and a "Download voice diagnostics" button (hidden when N = 0), reachable in read-only mode.
- File: `{ format: 'tennis-stats-voice-diagnostics', version: 1, exportedAt, match: { id, playedAt, format, opponent? }, diagnostics: [...] }`, rows sorted by `startedAt`. The opponent name is included (user's own file for own analysis) **[call]**.
- Name: `tennis-stats-voice-diagnostics-<matchId>-YYYY-MM-DD.json` via injectable `FileTransfer.download`.

### 4.7 Tests (TDD)
Adapters: raw response and sanitised error captured, key never present. draftService: one row per attempt, retries append, timeout/cancel/offline logged, confirm/discard keep rows, a failing save does not break processing, cap and truncation. Repository: cascade on `deleteMatch`, `replaceAll` clears, snapshot unchanged. Migration: version advances, data untouched. UI: count, button, filename and JSON passed to `FileTransfer`.

## 5. Left to the builder
Exact module names, file split, `Text` helper placement, UI copy/styling consistent with existing Match Details sections.

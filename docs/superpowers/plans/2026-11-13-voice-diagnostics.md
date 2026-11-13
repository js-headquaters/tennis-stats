# Voice Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one match-scoped diagnostics row for every transcription/parser provider call (all retries and errors, no audio), keep it after draft confirm/discard, and let the user download it as JSON from Match Details.

**Architecture:** A new Dexie table `diagnostics` (outside `DatabaseSnapshot`/backups). Provider adapters report raw response / HTTP error excerpts into an optional `AttemptTrace` passed as a third argument; `draftService` creates a trace per call and writes one row after the call settles (best effort, never breaks processing). Match Details lists the count and downloads a JSON envelope through the injectable `FileTransfer`.

**Tech Stack:** React + TypeScript + Vite, Dexie/IndexedDB (fake-indexeddb in tests), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-13-voice-diagnostics-design.md` (approved by the user 2026-11-13).

## Global Constraints

- Never store API keys, `Authorization`, `x-api-key`, request headers, or audio in a diagnostics row or download.
- A diagnostics write failure must never change the result of draft processing.
- Text caps: 256 KB (`262144` chars) per `DiagnosticText`; HTTP error `body` 8 KB (`8192` chars); 500 rows per match; on overflow delete oldest `success` rows first, then oldest rows overall.
- Diagnostics are not part of `DatabaseSnapshot`, `snapshot()`, `insertRecords` or backup files.
- `confirmDraft`, `discardDraft` and draft migrations never touch diagnostics; `deleteMatch` and `replaceAll` remove them.
- Dexie `version(2)` + `DATA_VERSION = 3` with a no-op migration `2`.
- Download file: `{ format: 'tennis-stats-voice-diagnostics', version: 1, exportedAt, match: { id, playedAt, format, opponent? }, diagnostics: [...] }`, rows sorted by `startedAt`; filename `tennis-stats-voice-diagnostics-<matchId>-YYYY-MM-DD.json`; the button is hidden when there are 0 rows; works in read-only recovery mode.
- Code style: small modules, injected clock/ids/FileTransfer, Vitest. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Verification before every commit that touches code: `npm test`, `npm run typecheck`, `npm run lint`.

## Review Focus

- Sentinel API key (`SENTINEL_FAKE_KEY`) must not appear in any stored row or download, for success, HTTP error, invalid response and thrown-error paths (Tasks 3, 4).
- `saveDiagnostic` rejecting (quota, read-only recovery) while a draft is processed: draft still reaches `ready`/`waiting-retry` with the right error (Task 4).
- Provider ignoring the abort signal (timeout/cancel): one row with outcome `timeout`/`cancelled`, written once, not again when the provider later settles (Task 4).
- Draft confirmed or discarded, then the match opened: rows still listed and downloadable (Tasks 2, 5).
- Match with more than 500 rows: errors survive, oldest successes go first (Task 2).

---

### Task 1: Diagnostic types and bounded text helper

**Files:**
- Modify: `src/domain/model.ts` (append types)
- Create: `src/domain/diagnostics.ts`
- Test: `src/domain/diagnostics.test.ts`

**Interfaces:**
- Produces (in `model.ts`):
  ```ts
  export interface DiagnosticText { value: string; truncated: boolean; originalLength: number }
  export type DiagnosticOutcome = 'success' | 'error' | 'cancelled' | 'timeout' | 'offline';
  export interface MatchDiagnostic {
    id: string; matchId: string; setId: string | null; draftId: string | null;
    phase: 'transcription' | 'parser'; attempt: number;
    provider: string; model: string; startedAt: string; finishedAt: string;
    outcome: DiagnosticOutcome;
    transcript: DiagnosticText | null; request: DiagnosticText | null; response: DiagnosticText | null;
    error: { code: string; message: string; status?: number; body?: DiagnosticText } | null;
  }
  ```
- Produces (in `diagnostics.ts`):
  ```ts
  export const DIAGNOSTIC_TEXT_LIMIT = 262144; export const DIAGNOSTIC_BODY_LIMIT = 8192; export const DIAGNOSTICS_PER_MATCH = 500;
  export function boundText(value: string, limit?: number): DiagnosticText;   // default limit DIAGNOSTIC_TEXT_LIMIT
  export function diagnosticsToDelete(rows: Pick<MatchDiagnostic, 'id' | 'startedAt' | 'outcome'>[], cap?: number): string[]; // ids to delete so that rows.length <= cap
  ```

- [x] **Step 1: Write failing tests** in `src/domain/diagnostics.test.ts`: `boundText('abc')` → `{ value:'abc', truncated:false, originalLength:3 }`; `boundText('x'.repeat(10), 4)` → `{ value:'xxxx', truncated:true, originalLength:10 }`; `diagnosticsToDelete` with 5 rows (2 `success` oldest, 3 `error`) and `cap=3` returns the two success ids; with 4 errors and `cap=3` returns the single oldest error id; with `rows.length <= cap` returns `[]`; ordering is by `startedAt` ascending, ties by array order.
- [x] **Step 2: Run** `npx vitest run src/domain/diagnostics.test.ts` — expect FAIL (module missing).
- [x] **Step 3: Implement** the types and the two functions as specified above; `diagnosticsToDelete` removes the oldest `success` rows first, then the oldest of the rest.
- [x] **Step 4: Run** the test file — expect PASS; run `npm run typecheck`.
- [x] **Step 5: Commit** `feat: add voice diagnostic types and bounded text helper`.

---

### Task 2: Storage — table, migration, repository, cascade

**Files:**
- Modify: `src/infrastructure/db/schema.ts`, `src/infrastructure/db/migrations.ts`, `src/infrastructure/db/repositories.ts`, `src/application/ports.ts`
- Test: `src/infrastructure/db/repositories.test.ts`, `src/infrastructure/db/migrations.test.ts`

**Interfaces:**
- Consumes: `MatchDiagnostic`, `diagnosticsToDelete`, `DIAGNOSTICS_PER_MATCH` (Task 1).
- Produces on `TennisRepository` (ports.ts) and `IndexedDbTennisRepository`:
  ```ts
  saveDiagnostic(row: MatchDiagnostic): Promise<void>;       // writable(); upserts, then prunes the match to DIAGNOSTICS_PER_MATCH in the same transaction
  listDiagnostics(matchId: string): Promise<MatchDiagnostic[]>; // sorted by startedAt ascending
  countDiagnostics(matchId: string): Promise<number>;
  ```
  `TennisDatabase.diagnostics!: Table<MatchDiagnostic, string>`; `DATA_VERSION = 3`.

- [x] **Step 1: Write failing tests** (existing files, fake-indexeddb): (a) save two rows for match A and one for B; `listDiagnostics('A')` returns only A's, sorted by `startedAt`, `countDiagnostics` matches. (b) `deleteMatch('A')` removes A's rows and keeps B's. (c) after `saveDraft` + `confirmDraft` of a draft for A (reuse the file's existing confirm fixtures) rows for A remain; same after `deleteDraft`. (d) `replaceAll(snapshot)` empties diagnostics; `snapshot()` result has no `diagnostics` key. (e) saving 505 rows (first 5 `success`, rest `error`) leaves 500 with the five successes gone; saving 501 `error` rows removes only the oldest. (f) in read-only recovery mode `saveDiagnostic` rejects with `ReadOnlyRecoveryError` while `listDiagnostics` works (follow the pattern in `recovery.test.ts`). (g) migrations test: opening a database stored at data version 2 advances `metadata.dataVersion` to 3 and leaves matches/drafts untouched. Update any assertion that hardcodes the old data version only if it does not use `DATA_VERSION`.
- [x] **Step 2: Run** `npx vitest run src/infrastructure/db` — expect FAIL.
- [x] **Step 3: Implement.** `schema.ts`: add `this.version(2).stores({ diagnostics: 'id, matchId, draftId, startedAt' })` (keep version 1 block as is). `migrations.ts`: `DATA_VERSION = 3`, add `2: async () => {}`. `repositories.ts`: implement the three methods; `deleteMatch` transaction adds `this.db.diagnostics` and `where('matchId').equals(id).delete()`; `replaceAll` already clears `db.tables`. `ports.ts`: add the three methods to `TennisRepository`.
- [x] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint` — expect all green (fix any hand-written repository fakes in other tests by adding the three methods).
- [x] **Step 5: Commit** `feat: store voice diagnostics per match`.

---

### Task 3: Provider capture via AttemptTrace

**Files:**
- Modify: `src/application/ports.ts`, `src/infrastructure/ai/common.ts`, `src/infrastructure/ai/openAiTranscription.ts`, `src/infrastructure/ai/openAiParser.ts`, `src/infrastructure/ai/anthropicParser.ts`
- Test: `src/infrastructure/ai/providers.test.ts`

**Interfaces:**
- Produces in `ports.ts`:
  ```ts
  export interface AttemptTrace {
    target(provider: string, model: string): void;
    request(text: string): void;               // parser: exactly the user message sent (requestPayload output)
    response(text: string): void;              // raw response body text, success or invalid
    httpError(status: number, body: string): void;
  }
  ```
  `TranscriptionProvider.transcribe(request, signal, trace?: AttemptTrace)`, `StatisticsParser.parse(request, signal, trace?: AttemptTrace)`.
- `requestJson(fetcher, url, init, signal, trace?: AttemptTrace)`: reads the body as text. Non-OK: `trace?.httpError(status, text)` (text read inside try/catch, empty string on failure) then throws the same `SafeProviderError` as today. OK: `trace?.response(text)` then `JSON.parse(text)`, failures throw `SafeProviderError('invalid-response')`. Headers and the request `init` are never passed to the trace.
- Adapters: call `trace?.target(provider, config.model)` first (before `validateConfig`), parsers call `trace?.request(requestPayload(request))` before sending; OpenAI parser/Anthropic parser need no extra call for raw content because `response` already holds the whole body. All trace calls are wrapped so a throwing trace cannot change adapter behaviour.

- [ ] **Step 1: Write failing tests** in `providers.test.ts` with a recording trace and a mock `fetch` returning `new Response(body, { status })`: (a) transcription success → `target('openai', model)`, `response` equals the raw JSON text. (b) 429 with body `{"error":"slow down"}` → `httpError(429, '{"error":"slow down"}')` and the adapter still rejects with code `rate`. (c) 200 with non-JSON body → `response('not json')` recorded, rejects `invalid-response`. (d) parser success for OpenAI and Anthropic → `request` equals `requestPayload(req)`, `response` is the raw body. (e) for every case, `JSON.stringify(allTraceCalls)` does not contain `SENTINEL_FAKE_KEY` (key lives only in headers). (f) a trace whose methods throw does not change the resolved/rejected result. (g) all existing tests still pass with no trace argument (fix mocks that only provide `json()` by returning real `Response` objects).
- [ ] **Step 2: Run** `npx vitest run src/infrastructure/ai` — expect FAIL.
- [ ] **Step 3: Implement** as specified; add a tiny `safeTrace(trace)` wrapper in `common.ts` that swallows exceptions from trace methods.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: capture raw provider responses and HTTP errors through an attempt trace`.

---

### Task 4: draftService wiring and production providers

**Files:**
- Modify: `src/application/draftService.ts`, `src/app/dependencies.ts`
- Test: `src/application/draftService.test.ts`

**Interfaces:**
- Consumes: `AttemptTrace`, `repository.saveDiagnostic/listDiagnostics` (Tasks 2–3), `boundText`, `DIAGNOSTIC_BODY_LIMIT` (Task 1).
- Produces: no new exports. Behaviour: in `process`, every provider call (transcription, parser) and the offline early return write exactly one `MatchDiagnostic`:
  - `id: ids.next()`, `matchId/draftId/setId` from the draft, `phase`, `attempt` = existing rows for that `draftId`+`phase` + 1 (via `listDiagnostics(matchId)`), `startedAt`/`finishedAt` from `clock`.
  - `provider`/`model` from `trace.target(...)`, else the returned transcript's values, else `'unknown'`.
  - `outcome`: `success`; `cancelled`/`timeout` for those codes; `offline` for the offline path; `error` otherwise. `error` = `{ code, message }` using the service's fixed `messages` text, plus `status` and `body: boundText(body, DIAGNOSTIC_BODY_LIMIT)` when the trace saw an HTTP error.
  - `transcript`: transcription text on success (bounded), and for parser rows the transcript sent; `request`/`response` from the trace (bounded). Parser results rejected by the service's own `draftSchema` count as `error` / `invalid-response` with the response kept.
  - Row writing is awaited but wrapped in try/catch that swallows every error (`console.warn` with no payload); it happens once per call, after `bounded` settles (also when the provider ignores abort and the timeout/cancel won).
- `dependencies.ts`: the wrapper providers forward the third `trace` argument to the real adapters.

- [ ] **Step 1: Write failing tests** (extend `setup()` to return the repository; fake providers take the trace and call `trace.response('{"raw":1}')` etc.): (a) happy path: 1 transcription row + 1 parser row, `attempt` 1, outcomes `success`, `transcript.value==='won'`, provider/model from the fake, `response` present. (b) transcription failure then `retryDraft` success: rows `error` (attempt 1) then `success` (attempt 2); the error row keeps `status`/`body` when the fake calls `trace.httpError(500,'boom')`. (c) timeout via the manual scheduler: one `timeout` row, and after the hung provider later resolves no second row appears. (d) abort signal → `cancelled` row. (e) offline: `isOnline` false → one `offline` row, no provider call. (f) `confirmDraft` and `discardDraft` leave all rows; `listDiagnostics` still returns them. (g) parser returns invalid shape → `error`/`invalid-response` row with `response` present. (h) `repository.saveDiagnostic` made to reject: `retryDraft` still resolves with `state:'ready'`; for a failing provider it resolves `waiting-retry` with the unchanged error code. (i) `refineDraftWithAudio` appends rows with incremented `attempt`. (j) sentinel key present in a provider's thrown `Error('SENTINEL_FAKE_KEY')` message never appears in any row (`JSON.stringify(rows)`).
- [ ] **Step 2: Run** `npx vitest run src/application/draftService.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** a small internal helper in `draftService.ts` (`recordAttempt`) plus a `createTrace()` collecting target/request/response/httpError; pass `trace` as the third argument of both provider calls. Update `dependencies.ts` wrappers to forward `trace`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: log every transcription and parser attempt as match diagnostics`.

---

### Task 5: Diagnostics export and Match Details UI

**Files:**
- Create: `src/application/diagnosticsExport.ts`
- Modify: `src/features/matches/MatchDetailsPage.tsx`
- Test: `src/application/diagnosticsExport.test.ts`, `src/features/matches/MatchDetailsPage.test.tsx`

**Interfaces:**
- Consumes: `repository.listDiagnostics/countDiagnostics` (Task 2), `FileTransfer` and `createBrowserFileTransfer` from `src/infrastructure/backup/fileTransfer.ts`.
- Produces:
  ```ts
  export const DIAGNOSTICS_FORMAT = 'tennis-stats-voice-diagnostics';
  export function buildDiagnosticsExport(bundle: MatchBundle, rows: MatchDiagnostic[], exportedAt: string): { fileName: string; text: string };
  ```
  `fileName` = `tennis-stats-voice-diagnostics-<matchId>-YYYY-MM-DD.json` (UTC date of `exportedAt`); `text` = `JSON.stringify` (2-space indent) of the envelope from Global Constraints with `match.opponent` = opponent name; rows sorted by `startedAt`.
- `MatchDetailsPage` gets an optional prop `transfer?: FileTransfer` (default `createBrowserFileTransfer()` created lazily via `useState`, as `DataSettingsSection` does). After the bundle loads it also reads `countDiagnostics(matchId)` (failure ⇒ treated as 0, never blocks the page). When count > 0 it renders `Voice diagnostics: N events` and a button `Download voice diagnostics`; click lists rows, builds the export with `services.clock.now()`, calls `transfer.download(fileName, text)`, shows a `role="status"` notice `Voice diagnostics downloaded.`; a `FileTransferError`/other failure shows `role="alert"`. Not disabled in read-only mode; disabled only while `busy`. The button has the same 44px touch-target treatment as neighbouring buttons.

- [ ] **Step 1: Write failing tests.** Export: file name and envelope fields for a sample bundle; rows sorted; no audio/`recording` keys; JSON round-trips. UI (existing `MatchDetailsPage.test.tsx` style, real fake-indexeddb repo, fake `transfer` with `vi.fn()`): (a) no rows ⇒ no section/button. (b) two saved rows ⇒ text `Voice diagnostics: 2 events` and button; click calls `download` once with the expected name and parseable JSON containing both rows. (c) with a repo in read-only recovery mode (pattern from `recovery.test.ts`/existing read-only test in this file) the button is present and works. (d) `download` throwing shows an alert and the page stays usable. (e) existing tests untouched and passing.
- [ ] **Step 2: Run** `npx vitest run src/application/diagnosticsExport.test.ts src/features/matches/MatchDetailsPage.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** `buildDiagnosticsExport` and the UI section (place it after the comments form, inside a `<section aria-label="Voice diagnostics">`).
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 5: Commit** `feat: download voice diagnostics from match details`.

---

### Task 6: Full gate and docs

**Files:**
- Modify: `README.md` (short "Voice diagnostics" note: what is stored, that it is excluded from backups, how to download); `docs/superpowers/plans/2026-11-13-voice-diagnostics.md` (tick checkboxes).
- Test: e2e only if an existing journey breaks.

- [ ] **Step 1: Run** `npm run typecheck && npm run lint && npm test && npm run build && npm run verify:pwa` — expect exit 0.
- [ ] **Step 2: Run** `npm run test:e2e -- --project=chromium` — expect pass (existing journeys; the Dexie version bump must not break them). Fix regressions only.
- [ ] **Step 3: Add README note**; confirm no key/audio can reach a row with `grep -rn "apiKey\|Authorization" src/application/draftService.ts src/application/diagnosticsExport.ts` returning nothing.
- [ ] **Step 4: Commit** `docs: describe voice diagnostics`.

# Tennis Stats PWA Design

## Intent

Build a personal, mobile-first tennis statistics application for courtside use at recreational/congregational-level matches. The application should make it quick to record one or several completed games by voice, review what AI understood, correct it, and build useful match history and error trends over time.

The application is for one person and one browser profile in its first release. It deliberately avoids accounts and a remote application database. Tennis data stays local, while user-supplied AI services process voice and structured-language requests.

## Goals

- Start and manage a tennis match from a phone.
- Record one or several completed games in one voice entry.
- Separate audio transcription from transcript-to-statistics parsing so either provider can be replaced.
- Require review and confirmation before AI-created records enter a match.
- Allow further voice corrections to the current draft and manual correction of all data at any time.
- Organize records by game, set, tie-break, and match.
- Support one-set matches, best-of-three, two sets plus a deciding super tie-break, and manually completed practice matches.
- Show average personal errors per recorded game and average failed returns per return game over weekly and monthly periods.
- Preserve data locally with explicit migrations and versioned export/import backups.
- Be installable as a PWA and usable offline except for AI calls.
- Deploy the `develop` branch to GitHub Pages under `js-headquaters/tennis-stats`.
- Protect critical behavior with automated unit/integration tests and end-to-end tests.

## Non-goals for the first release

- User accounts, login, cloud synchronization, or a remote match database.
- Opponent statistics beyond identity and the context of who served.
- Point-by-point match scoring.
- Point-by-point tie-break scoring.
- Dashboard breakdowns for service games versus return games.
- Raw total-error charts.
- Social, team, tournament, or sharing features.
- A permanent server or custom backend for protecting provider credentials.
- Distinguishing forced from unforced errors.

## Anti-goals

- Do not silently turn missing statistics into zero.
- Do not save AI interpretations without explicit user confirmation.
- Do not couple match logic to a particular AI provider, React component, or IndexedDB implementation.
- Do not expose API keys in source control, builds, logs, backups, analytics, test fixtures, or service-worker caches.
- Do not over-engineer future analytics or use event sourcing for this MVP.
- Do not optimize desktop layout at the expense of fast, sunlight-readable phone use.

## Constraints and accepted risks

- The application is a static GitHub Pages deployment at `https://js-headquaters.github.io/tennis-stats/`.
- The user explicitly chose to enter and persist provider API keys in browser local storage. This is less secure than a backend proxy and conflicts with provider guidance against browser-held keys. Settings must explain the risk and recommend restricted, expiring keys with hard spend limits.
- AI calls require connectivity. Core match review, manual entry, editing, history, and dashboards work offline.
- Browser data can be erased or become unavailable after changing devices/origins, so backup and restore are first-release requirements.
- GitHub Pages serves from a repository subpath, so routing, manifests, assets, and service-worker scope must honor `/tennis-stats/`.
- Primary mobile targets are current iPhone Safari and Chrome on iOS. Because both use Apple's WebKit engine, recording/PWA behavior must be tested on real or simulated iOS behavior rather than assuming desktop Chrome compatibility. Current desktop browsers are secondary targets.

## Considered approaches

### 1. Modular React PWA — selected

Use React, TypeScript, and Vite for the UI; keep scoring/statistics logic in plain TypeScript; access IndexedDB through a repository layer; use replaceable AI adapters; and test user journeys with Playwright.

This has more setup than a single-file application, but provides the best balance of maintainability, testability, mobile/PWA support, and incremental growth.

### 2. Event-sourced application

Persist every action and derive the current match from an immutable event stream. This would provide a complete correction history but adds substantial complexity to migrations, projections, imports, and debugging that the personal MVP does not need.

### 3. One JSON document per match

Replace a complete match document after every edit. This is initially simple but makes reusable opponents, partial updates, migrations, imports, and cross-match statistics increasingly awkward.

## Technical shape

Use a client-only modular architecture:

1. **Presentation** — React pages and components.
2. **Application services** — use cases such as start match, add draft games, confirm draft, finish set, edit game, finish match, calculate dashboard, export, and import.
3. **Domain** — framework-free entities, scoring rules, serving inference, validation, and statistics calculations.
4. **Persistence** — IndexedDB repositories and migration runner.
5. **AI** — independent transcription and statistics-parser interfaces with provider-specific adapters.
6. **Platform** — microphone recording, connectivity, PWA/service worker, downloads/uploads, and local settings.

Initial library choices are React + TypeScript + Vite, Dexie for IndexedDB, React Router configured for the Pages base path, `vite-plugin-pwa`, a lightweight React chart library, Vitest + Testing Library, and Playwright. Library use must remain behind local interfaces where it affects domain or persistence behavior.

## Navigation and screens

Use bottom navigation with **Home**, **Matches**, and **Settings**. During an active match, returning to the application must provide a direct resume path.

### Dashboard / Home

The selected direction is **statistics first**:

- Weekly/monthly period selector at the top.
- Average net, wide, long, and double-fault errors per recorded game.
- Average failed returns per return game.
- Trend visualization and sample size for each metric.
- Recent matches below the statistics.
- Persistent floating action for starting a match.
- Active-match resume card appears prominently when applicable without replacing statistics.

Weekly and monthly selectors use calendar periods: Monday through Sunday for weeks and normal calendar months. Users can navigate to earlier periods. Trend indicators compare the selected period with the immediately preceding equivalent calendar period, while showing sample size so sparse periods are not overstated.

Do not display raw error totals in the dashboard.

### Start match

- Search and select an existing opponent or create a new opponent inline.
- Match date/time defaults to now and is editable.
- Match-format chooser in this order:
  1. Two sets plus deciding super tie-break (preselected)
  2. Open/practice match with manual completion
  3. One set
  4. Best of three sets
- Select whether the user or opponent serves first.

### Active match

- Show opponent, date, format, current set score, and expected next server.
- Show recent games with clear result, serving context, optional score, and large high-contrast statistics.
- Primary action: add one or more games by voice.
- Secondary action: enter games manually.
- Allow ending a set early and opening match-level actions.

### Voice recording and review

- Record a bounded voice message with the browser `MediaRecorder` API.
- A recording can describe one or several consecutive games.
- Send audio through the configured transcription adapter.
- Send the transcript plus relevant current-match/draft context through the configured statistics-parser adapter.
- Validate parser output against a strict local schema; never trust provider JSON directly.
- Show every parsed game as an editable draft card.
- Let the user add or correct draft information with another recording; run the same transcription/parse/validation cycle and show the revised draft again.
- Keep the original transcript available in the draft review for troubleshooting, but do not require saving audio after confirmation.
- Commit nothing to the match until **Confirm and add**.
- If offline or an AI call fails, retain the recording/draft locally and offer retry or manual entry.

### Match history

- Sort newest first.
- Filter by date range and reusable opponent.
- Show date, opponent, match/set result, completion state, and format.

### Match details

- Set-by-set and game-by-game records.
- Tie-break/super tie-break summaries.
- Match-level averages and recorded-sample counts.
- Match comments for feelings, focus, and free-form observations.
- Edit any match metadata, game, set, tie-break, or comment after completion.
- Recalculate dependent scores and dashboards after correction.

### Settings

Independent sections for:

- **Transcription AI:** provider, API key, model, optional endpoint, test connection, clear key.
- **Statistics-parsing AI:** provider, API key, model, optional endpoint, test connection, clear key.
- **Data:** export backup, import backup, clear all data with strong confirmation.
- **Application:** installation/offline status and application/schema version.

Keys are masked, entered at runtime, persisted in local storage only after explicit save, excluded from all exports, and removable independently. A warning explains client-side key exposure and recommends restricted, expiring, hard-budgeted keys.

## Visual direction and accessibility

- Use the selected statistics-first dashboard.
- Use the selected **tennis-lime header** style, softened from the mockup: dark charcoal text on a calmer, slightly muted lime background.
- Use white or very light surfaces, dark-gray primary text, and muted explicit borders. Preserve readable contrast without making the interface feel harsh or near-black.
- Game-card statistics use large labels and values in separate cells; avoid compressed inline strings such as “Net 0 Wide 1.”
- Design for outdoor readability, touch targets of at least 44px, one-handed phone operation, and visible focus states.
- Never rely on color alone for won/lost, unknown values, errors, or validation state.
- Use `—` plus an accessible label for unknown values; use `0` only when explicitly recorded.

## Domain model

Identifiers are stable generated IDs. Every persisted record has creation/update timestamps and an application data version where needed.

### Opponent

- `id`
- `name`
- normalized name used for lookup/import deduplication
- timestamps

Names are reusable and searchable. First-release opponent management is intentionally limited to creation and use; renaming may be done through a match edit and repository-level update if required.

### Match

- `id`
- `opponentId`
- `playedAt`
- `format`: `twoSetsSuperTiebreak | openPractice | oneSet | bestOfThree`
- `firstServer`: `player | opponent`
- `status`: `active | completed | abandoned`
- ordered set IDs
- optional match comments
- timestamps

The outcome is derived from sets/tie-breaks rather than independently editable duplicate fields.

Only one match may be active at a time. Starting another match requires completing or explicitly abandoning the current active match. Abandoning preserves all recorded sets/games and labels the match incomplete. Editing a completed or abandoned match changes its stored records in place and does not reactivate it or block starting another match.

### Set

- `id`, `matchId`, and ordinal
- `kind`: `standard | decidingSuperTiebreak`
- `status`: `active | completed | unfinished`
- ordered game IDs for standard sets
- optional tie-break ID
- derived score/result
- timestamps

### Game

- `id`, `setId`, and ordinal
- explicit `server`: `player | opponent`
- `result`: `won | lost`
- optional final game score
- `netErrors`, `wideErrors`, `longErrors`, `doubleFaults`: non-negative integer or `null` for unknown
- `failedReturns`: non-negative integer or `null` for unknown; valid only when the opponent served
- timestamps

Serving is initially inferred from `firstServer` and game order, but stored explicitly on each confirmed game. Later corrections do not silently rewrite all following servers; any affected records are shown for review.

### Tie-break

- `id`, `setId`
- `kind`: `standard | super`
- final player/opponent points
- result derived from final score
- aggregate `netErrors`, `wideErrors`, `longErrors`, `doubleFaults`, each integer or `null`
- timestamps

Tie-breaks are distinct from normal games. Their errors contribute to set and match details. Dashboard “per game” calculations exclude tie-break aggregates because they are not normal games; a future dashboard may show them separately.

### Voice draft

- temporary ID and match/set association
- local recording blob when retry is needed
- transcript history
- current parsed draft games/tie-break
- processing/error state
- timestamps

Confirmed drafts create domain records transactionally and are then removed. Audio is deleted after confirmation unless needed for a failed/retry state.

## Tennis and completion rules

- A normal game contributes one game to the current standard set based on `won` or `lost`; point-level scoring is not tracked.
- Optional final game score is descriptive and validated for consistency where practical, but game result remains explicit.
- A standard set completes automatically on a valid standard score: at least six games, at least two ahead, or 7–6 after a standard tie-break.
- At 6–6, prompt for the standard tie-break final score and aggregate errors.
- **End set early** marks the set `unfinished`; it does not invent a set winner. Its games still contribute to match details and dashboard statistics.
- Two-sets-plus-super-tie-break format uses a deciding super tie-break when the first two completed sets are split. An unfinished set does not count as won.
- One-set and best-of-three formats complete automatically when their required completed-set wins are reached.
- Open/practice matches complete only through an explicit action.
- The user can manually finish a match when time or circumstances prevent normal completion; incomplete portions remain labeled rather than inferred.
- Corrections rerun scoring validation. If changing an earlier result conflicts with later structure, the UI explains the conflict and asks the user to fix or confirm affected records.

## Statistics semantics

Track only the user's errors:

- **Net:** the user's shot ended the point in the net.
- **Wide:** the user's shot ended the point outside a sideline.
- **Long:** the user's shot ended the point beyond the baseline.
- **Double fault:** the user's service game contained the recorded number of double faults.
- **Failed return:** in a return game, an opponent serve that the user did not return into play. Do not distinguish an ace from an attempted-but-failed return, and do not also classify that point as net, wide, or long.

Do not distinguish forced and unforced errors in the first release. The UI and AI parser keep failed returns separate from net/wide/long, but aggregate game-level counts cannot prove that the user did not count the same real-world point twice; this is guidance and input validation, not point-level mathematical enforcement.

For each metric, average only over normal games where that metric is known:

`average = sum(known values) / count(games with known value)`

Explicit zero participates in the average; `null` does not. Show the denominator/sample size. Dashboard periods are based on `Match.playedAt`, not creation time. Weekly and monthly views aggregate normal games across qualifying matches.

Failed-return averages use only return games with a known `failedReturns` value as their denominator. They are shown as failed returns per return game, not per all games. Broader dashboard analysis and additional filters are deferred until real usage indicates what is useful.

## AI interfaces

### Transcription provider

Conceptual contract:

- accepts audio blob, MIME type, language/context hints, and cancellation signal
- returns transcript text and provider metadata needed for diagnostics
- never returns domain records

The initial OpenAI adapter uses the provider's current supported file-transcription endpoint/model configured in Settings. Model names are configuration, not domain constants.

### Statistics parser

Conceptual contract:

- accepts transcript, current match context, existing draft, and expected next game/server
- returns a versioned structured draft matching a strict schema
- supports adding games and correcting the existing draft
- does not persist data

The first release requires an OpenAI transcription adapter and text-parser adapters for both OpenAI and Anthropic. Invalid, ambiguous, or incomplete output becomes a review warning, never guessed persisted data. The parser prompt treats transcript content as data and restricts output to the schema.

## Persistence and migrations

Use IndexedDB for all tennis/application data and pending audio. Use local storage only for AI provider settings/keys and small non-domain UI preferences.

Dexie schema versions handle physical index/store changes. A separate explicit data-migration pipeline handles semantic record changes and is tested against fixtures from every prior released version. Migrations are forward-only, transactional where possible, idempotent where retry is possible, and never delete unknown data silently.

Startup behavior:

1. Open database.
2. Run required schema/data migrations.
3. If migration fails, stop writes, preserve the database, and offer diagnostics/export rather than resetting data.

## Backup and restore

Export one human-inspectable, versioned JSON file containing opponents, matches, sets, games, tie-breaks, comments, and compatible application preferences. Exclude API keys, provider secrets, transient recordings, and service-worker state.

On import:

1. Parse and validate without changing current data.
2. Migrate older backup versions in memory.
3. Show a summary and any rejected records.
4. Offer **merge** or **replace**.
5. For merge, deduplicate by stable IDs and normalized opponent name, and report conflicts rather than silently overwriting divergent records.
6. Apply accepted data transactionally.

## Offline/PWA behavior

- Cache the application shell and required static assets under the GitHub Pages scope.
- Read/write IndexedDB offline.
- Allow starting, editing, and manually recording matches offline.
- Keep failed/offline voice recordings as retryable local drafts.
- Clearly show when transcription is waiting for connectivity.
- Never cache AI requests, responses containing credentials, or authorization headers in the service worker.
- Notify the user when an update is available and activate it through an explicit reload action so an active recording/draft is not lost.

## Failure handling

- Microphone denied: explain how to enable it and retain manual entry.
- Missing provider configuration: link directly to the relevant Settings section.
- Provider authentication/rate/spend failure: retain recording and draft; show a safe error without key/request headers.
- Parser ambiguity: highlight uncertain fields and require correction/confirmation.
- IndexedDB quota/write failure: stop claiming the record was saved and offer export/cleanup guidance.
- Import/migration failure: preserve existing data and provide a useful, secret-free error.
- AI operations are cancelable and protected from duplicate submission.

## Testing strategy

### Domain/unit tests

- Set and match completion for every format.
- Standard and deciding tie-break behavior.
- Early unfinished sets.
- Serving alternation and correction effects.
- Unknown-versus-zero statistics and per-metric denominators.
- Failed-return field eligibility, parser/UI separation from shot-error categories, and return-game-only averages.
- Dashboard date periods and averages.
- Calendar-week/calendar-month navigation and preceding-period trend comparisons.
- Parser schema validation and normalization.
- Backup validation, migration, merge, and replace behavior.
- Every data migration using fixed old-version fixtures.

### Integration/component tests

- IndexedDB repositories and transactions.
- AI adapter contracts with mocked network responses.
- Draft refinement and confirmation.
- Settings masking, persistence, connection tests, and secret exclusion.
- PWA offline/error states where practical.

### Playwright end-to-end tests

Run against the production build with deterministic mocked AI endpoints. Critical journeys:

1. Create/reuse an opponent and start each match format.
2. Record a mocked batch transcript, review multiple games, voice-correct the draft, and confirm.
3. Enter a game manually when AI is unavailable.
4. Infer serving order and edit a server/result/statistic.
5. Automatically complete a set and end another set early.
6. Add standard and super tie-break summaries.
7. Finish, reopen, correct, and recalculate a match.
8. Verify weekly/monthly error and failed-return averages, unknown handling, and sample size.
9. Filter history by opponent and date.
10. Reload/offline-resume an active match and pending draft.
11. Export, clear/replace, import, and verify restored data.
12. Upgrade a seeded previous database version without data loss.
13. Verify deployment-base routing and direct navigation under `/tennis-stats/`.
14. Exercise microphone permission, recording format fallback, installability, and offline resume on the iOS WebKit target; use Playwright WebKit where representative and document the small real-device smoke check required for behavior that automation cannot reproduce.

Keep a small smoke subset mandatory for every change and run the full suite in CI. Tests must never call paid AI APIs or contain real keys.

## Delivery and deployment

- Repository: `git@github.com:js-headquaters/tennis-stats.git`.
- Primary development/deployment branch: `develop`.
- GitHub Actions runs type checking, linting, unit/integration tests, production build, and critical Playwright tests before deployment.
- Deploy to GitHub Pages only after the required checks succeed.
- Configure Vite base, router, manifest, and service worker for `/tennis-stats/`.

## Decisions left to the builder

- Exact component/file organization within the agreed layers.
- Exact chart library and chart presentation, provided sample size and accessibility remain clear.
- Exact OpenAI/Anthropic model defaults available at implementation time; users can override models in Settings.
- Fine visual spacing, icon set, typography, and loading animation within the selected softened lime direction and agreed readability requirements.
- Whether reusable opponent renaming needs a dedicated first-release control; this must not block selecting/filtering opponents.
- Exact test split between Vitest integration tests and Playwright, while preserving the listed coverage.

# Simplified Game Entry and Voice Comments Design

## Intent and why

Recording a game currently asks for too many separate error categories while the player is also trying to remember the match. The normal path should require only a few high-level numbers that are easy to recall: total unforced errors, double faults, and receive errors. Players who remember more detail may still record net, wide, and long errors without making that detail mandatory.

Voice entry should understand the same high-level statistics and attach spoken observations to the specific game they describe. Match-level comments remain a separate manual field for general reflections during or after the match.

## Goals

- Make simplified entry the default for manual and voice-created games.
- Add an optional authoritative total-unforced-errors value to each game.
- Preserve optional net, wide, and long error breakdowns.
- Add an optional comment to each specific game.
- Preserve the existing editable match-level comment.
- Parse high-level statistics, detailed statistics, and game comments from speech.
- Keep AI-created information editable and require confirmation before adding it to the match.
- Preserve all existing records without inventing values during migration.
- Keep dashboard history continuous across old detailed records and new simplified records.

## Non-goals

- Removing net, wide, or long statistics.
- Requiring the high-level total to equal the optional detailed breakdown.
- Automatically distributing a total among net, wide, and long categories.
- Inferring comments or statistics that were not stated.
- Changing tie-break statistics or including tie-breaks in dashboard averages.
- Replacing the existing match-comments editor with voice-only editing.

## Anti-goals

- Do not make detailed entry necessary to save a game.
- Do not overwrite an explicit unforced-error total with a derived sum.
- Do not treat wholly missing statistics as zero.
- Do not erase existing detailed data or match comments during migration, import, voice confirmation, or editing.
- Do not commit parsed comments or statistics before review and confirmation.

## Constraints

- The application remains local-first and must support manual entry and editing offline.
- Existing IndexedDB data and versioned backup files must remain readable.
- The parser response remains strictly schema-validated and provider-independent.
- Double faults apply only when the player served. Receive errors use the existing persisted `failedReturns` field and apply only when the opponent served.
- Dashboard averages continue to use normal games only, not tie-break entities.
- Unknown values remain `null`; an explicitly recorded zero remains `0`.

## Approaches considered

### 1. Explicit total with optional details — selected

Store `unforcedErrors` independently from net, wide, and long errors. Use the explicit total when available and derive a fallback from available detailed values otherwise. This makes the common path simple, preserves old data, and allows partial detail without forcing artificial consistency.

### 2. Mutually exclusive simple and detailed modes

Store either a total or a detailed breakdown, but never both. This avoids differing values but makes corrections awkward and prevents a player from recording a confident total plus only the details they happen to remember.

### 3. Automatically synchronized total and details

Recalculate the total whenever details change and clear or redistribute details when the total changes. This creates misleading precision and risks silently changing user-entered information.

## Domain model and calculation rules

Add two nullable properties to every normal `Game` and `DraftGame`:

- `unforcedErrors: number | null`
- `comments: string | null`

The existing match-level `comments` property remains unchanged.

The effective unforced-error value for a game is resolved in this order:

1. If `game.unforcedErrors` is not `null`, use it, including an explicit `0`.
2. Otherwise, if at least one of `netErrors`, `wideErrors`, or `longErrors` is recorded, sum those fields while treating missing components as zero.
3. Otherwise, the value is unknown and the game is excluded from the unforced-error average.

An explicit total is authoritative even when it differs from the detailed sum. The details may represent only the categories the player remembered. Both values are retained and shown without an error or automatic correction.

All numeric statistics remain non-negative safe integers or `null`. Game comments are trimmed text, limited to the same safe maximum used for match comments, and stored as `null` when blank.

## Simplified manual entry

The default game form shows:

- Result
- Server
- Optional score
- Unforced errors
- Double faults when the player served, or Receive errors when the opponent served
- Game comment
- An **Add details** disclosure

Opening **Add details** reveals Net errors, Wide errors, and Long errors. Existing detailed values always cause this section to open when editing so they are not hidden accidentally. Switching the server clears only the now-inapplicable serve-specific field, following the current behavior; it does not alter unforced errors, details, or comments.

The form may save a game with all statistics blank. It may also save only the high-level total, only details, or both. The default screen therefore asks for at most two applicable numbers instead of five.

## Display and editing

Game cards and match details show the effective Unforced errors value, Double faults or Receive errors as applicable, and the game comment when present. When the unforced-error value came from net/wide/long, the UI identifies it briefly as derived from details. Detailed categories remain available in a compact expanded section and remain fully editable.

Match comments stay separate from game comments. The active-match screen and completed match details retain the existing match-comments editor, allowing a general reflection to be written or revised at the end of the match.

## Voice parsing and review

The parser schema advances to a new version and supports, per draft game:

- server and result
- `unforcedErrors`
- net, wide, and long errors
- double faults or receive errors as applicable
- `comments`

Examples of supported intent include:

- “I lost. Three unforced errors and one receive error. I was late on the backhand.”
- “Won my service game, two unforced errors, one into the net. I stayed calm.”

The parser attaches a game observation only to the game it accompanies. For multiple games, it returns a separate comment for each game. If speech is ambiguous about which game owns a statistic or comment, the parser leaves it unknown and emits a warning rather than guessing.

Draft review uses the same simplified-first layout as manual entry, with optional detailed fields. Each game comment is editable.

On confirmation, games and their comments are added atomically using the existing draft-confirmation flow. Voice confirmation does not change the general match comment.

Further voice recordings may correct or extend the existing draft, including its game comments and proposed match-comment addition. The parser receives only the existing draft and minimal scoring context, as it does today; stored confirmed comments and opponent identity are not sent to the provider.

## Persistence and migration

Increase the application data version. The IndexedDB object-store/index schema does not need a structural Dexie version because the new properties are not indexed, but the explicit data migration must update content:

- Existing games gain `unforcedErrors: null` and `comments: null` when those properties are absent.
- Existing net, wide, long, double-fault, and receive-error values remain byte-for-byte equivalent.
- Existing match comments remain unchanged.
- Existing voice drafts are upgraded to the new parsed-draft shape. Each draft game gains null high-level totals and comments. Draft recordings, transcripts, state, and detailed values remain intact.
- The migration is idempotent and must not replace properties that are already present.

No migration backfills `unforcedErrors` from details. Keeping it null preserves the distinction between an entered total and a dashboard fallback calculation.

Backup export advances to the new data version and includes both new game properties. Import accepts the current new format and older supported formats; older games are normalized with null new properties before validation and persistence. Strict validation continues to reject malformed or out-of-range fields. Export/import round trips must preserve null, zero, comments, explicit totals, and differing total/detail values exactly.

## Application and service changes

- Extend game input, patch, validation, preparation, and correction services with both new fields.
- Extend draft editing and confirmation with the new game fields.
- Centralize effective unforced-error resolution in the domain statistics layer and use it in dashboard and match summaries.
- Keep `failedReturns` as the persisted/internal field for compatibility while consistently labeling it **Receive errors** in simplified UI and voice instructions.
- Preserve existing conflict detection and match-scoring behavior; comments and statistics do not alter won/lost scoring.

## Error handling and accessibility

- Invalid totals or comments are rejected before persistence with a clear field-level message.
- Provider output that does not match the strict new schema remains a retryable invalid-response error.
- All draft content is reviewable before confirmation.
- The details disclosure is keyboard accessible and clearly announces expanded/collapsed state.
- Inputs retain explicit labels, 44×44 touch targets, visible focus, and unknown-versus-zero semantics.
- Comments use normal text areas suitable for dictation and manual correction.

## Verification

Automated coverage should prove:

- Explicit total wins over a differing detail sum.
- Detail sum is used only when the explicit total is null.
- Partial details count missing components as zero, while all-null data stays unknown.
- Zero is preserved as a recorded value.
- Simplified manual entry, optional details, server-specific fields, and game comments save and edit correctly.
- Parser adapters accept the new strict shape and reject malformed totals/comments.
- Voice refinement preserves and corrects comments and high-level statistics.
- Draft confirmation atomically stores game comments without changing the general match comment.
- Data migration preserves old details and adds only null new fields.
- Old backup import and new backup round trips preserve all supported information.
- Dashboard, match details, read-only recovery, offline behavior, and PWA update protections continue working.
- Mobile end-to-end flows cover one simple manual game and one voice draft containing game comments.

## Builder discretion

The builder may choose component boundaries, exact disclosure styling, concise helper text, and whether derived-detail labeling uses text or a small badge, provided the behavior and accessibility rules above remain intact.

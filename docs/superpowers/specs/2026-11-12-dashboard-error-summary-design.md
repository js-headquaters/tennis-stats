# Dashboard Error Summary Design

## Intent

Keep detailed entry and storage for net, wide, and long errors, while making the dashboard show only the three statistics the user cares about: Unforced errors, Double faults, and Receive errors.

## Goals

- Define Unforced errors as the per-game sum of `netErrors + wideErrors + longErrors`.
- Show only Unforced errors, Double faults, and Receive errors on the dashboard.
- Preserve existing period selection, averages, samples, trends, and charts.
- Keep net, wide, and long values available in existing game and match details.

## Non-goals

- Do not change game entry, voice parsing, persistence, backups, or database versions.
- Do not remove the detailed error fields from stored records.
- Do not add a new dashboard drill-down screen.

## Semantics

- A game with at least one recorded net, wide, or long value contributes the sum of its known values; missing components contribute zero.
- A game with all three component values `null` is not included in the Unforced errors sample.
- Double faults continue to use player service games as their denominator.
- Receive errors use the existing `failedReturns` data and return-game denominator; only the dashboard label changes.

## Approach

Add a derived `unforcedErrors` dashboard metric in the statistics layer, while retaining the five persisted `RecordedMetric` fields. Restrict the dashboard metric list to the three desired cards. This keeps aggregation and trend logic out of the UI and avoids a data migration. Calculating only in the component would duplicate domain logic; replacing the stored fields would destroy the detailed breakdown and require migration.

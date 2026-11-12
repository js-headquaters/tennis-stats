# Dashboard Error Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate net/wide/long dashboard cards with one derived Unforced errors card, leaving Double faults and renamed Receive errors as the only other dashboard statistics.

**Architecture:** Keep persisted `RecordedMetric` fields unchanged. Introduce a dashboard-only metric type and derive unforced errors in `domain/statistics.ts`, so current/previous comparisons and chart history use one consistent calculation path.

**Tech Stack:** TypeScript, React, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-11-12-dashboard-error-summary-design.md`

## Global Constraints

- Keep net, wide, and long entry/storage unchanged.
- Do not migrate IndexedDB or backup formats.
- Preserve week/month periods, averages, samples, trends, and charts.
- Dashboard labels are exactly `Unforced errors`, `Double faults`, and `Receive errors`.

## Review Focus

- All-null components must remain unknown and not become a zero sample.
- Partially recorded components must sum known values without dropping the game.
- Explicit zero values must produce a real zero sample.
- Double-fault and receive-error server-specific denominators must remain unchanged.
- Dashboard history and current/previous trends must use the same derived aggregation.

---

### Task 1: Derived Dashboard Error Metrics

**Files:**
- Modify: `src/domain/statistics.ts`
- Modify: `src/domain/statistics.test.ts`
- Modify: `src/features/dashboard/DashboardPage.tsx`
- Modify: `src/features/dashboard/DashboardPage.test.tsx`
- Modify: `src/features/dashboard/DashboardPage.chartFailure.test.tsx`
- Modify: `src/features/dashboard/MetricCard.tsx`
- Modify: `src/features/dashboard/MetricCard.test.tsx`
- Modify: `src/features/dashboard/TrendChart.test.tsx`

**Interfaces:**
- Consumes: persisted `Game.netErrors`, `Game.wideErrors`, `Game.longErrors`, `Game.doubleFaults`, and `Game.failedReturns`.
- Produces: `DashboardMetric = 'unforcedErrors' | 'doubleFaults' | 'failedReturns'`, `DASHBOARD_METRICS`, and `calculateMetric(games, key)` summaries for those keys.

- [ ] **Step 1: Write failing domain tests**

Add tests proving that `unforcedErrors` sums net + wide + long per game, treats missing components as zero when another component is known, excludes all-null games, and counts explicit zero. Update dashboard-summary key assertions to the three dashboard metrics while preserving double-fault/failed-return denominator tests.

- [ ] **Step 2: Run domain tests and verify RED**

Run: `npm test -- src/domain/statistics.test.ts`

Expected: FAIL because `unforcedErrors` and the dashboard-only metric set do not exist.

- [ ] **Step 3: Implement the dashboard metric type and derived calculation**

In `src/domain/statistics.ts`, add `DashboardMetric`, export `DASHBOARD_METRICS`, make summary/comparison records use it, and make `calculateMetric(games, 'unforcedErrors')` derive a per-game sum with the spec's null semantics. Keep persisted model types unchanged.

- [ ] **Step 4: Run domain tests and verify GREEN**

Run: `npm test -- src/domain/statistics.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Write failing dashboard component tests**

Update tests to require exactly the Unforced errors, Double faults, and Receive errors cards; assert the unforced average/trend/chart use the derived sum; and assert Net/Wide/Long/Failed returns cards are absent.

- [ ] **Step 6: Run dashboard tests and verify RED**

Run: `npm test -- src/features/dashboard`

Expected: FAIL because the dashboard still renders five persisted metrics and old labels.

- [ ] **Step 7: Implement the three-card dashboard**

Use `DASHBOARD_METRICS` for summaries/history/rendering. Update `MetricCard` copy and types so `unforcedErrors` reads `Unforced errors` per recorded game and `failedReturns` reads `Receive errors` per return game.

- [ ] **Step 8: Run dashboard tests and verify GREEN**

Run: `npm test -- src/features/dashboard`

Expected: all tests pass.

- [ ] **Step 9: Run the release gate**

Run: `npm run typecheck && npm run lint && npm test && npm run build && npm run verify:pwa && npm run test:e2e -- --project=chromium --project=webkit`

Expected: all commands exit 0.

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-dashboard-error-summary-design.md docs/superpowers/plans/2026-11-12-dashboard-error-summary.md src/domain/statistics.ts src/domain/statistics.test.ts src/features/dashboard
git commit -m "feat: simplify dashboard error statistics"
```

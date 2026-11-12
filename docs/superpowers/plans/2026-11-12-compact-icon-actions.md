# Compact Icon Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Lucide icons and concise visible labels to navigation and frequent app actions without reducing accessibility or touch-target size.

**Architecture:** Add `lucide-react` and a shared `IconLabel` presentation component. Existing page components keep their behavior and full accessible names while replacing only visible action content.

**Tech Stack:** React, TypeScript, lucide-react, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-11-12-compact-icon-actions-design.md`

## Global Constraints

- Icons are decorative (`aria-hidden`) and never the only accessible name.
- Visible labels should be one or two words where practical.
- Destructive actions stay explicit in context.
- Every interactive target remains at least 44×44 CSS pixels.
- No page behavior or navigation destination changes.

## Review Focus

- Screen-reader queries must still find actions by their full original meaning.
- Loading labels such as `Saving…` must remain truthful while an action is pending.
- Dynamic game ordinals must remain available in accessible names after visible labels are shortened.
- Disabled buttons and destructive confirmation stages must remain unchanged.
- Lucide imports must tree-shake without materially changing the PWA base or service-worker output.

---

### Task 1: Shared Icon Label and Navigation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/components/IconLabel.tsx`
- Create: `src/components/IconLabel.test.tsx`
- Modify: `src/components/AppShell.tsx`
- Modify: `src/components/AppShell.test.tsx`
- Modify: `src/styles/global.css`

**Interfaces:**
- Produces: `IconLabel({ icon, children })`, rendering a Lucide icon with `aria-hidden="true"` and visible text.

- [ ] **Step 1: Add failing tests for decorative icons and icon navigation**
- [ ] **Step 2: Run focused tests and verify RED** — `npm test -- src/components/IconLabel.test.tsx src/components/AppShell.test.tsx`
- [ ] **Step 3: Install `lucide-react`, implement `IconLabel`, add Home/Matches/Settings icons, and add shared alignment CSS**
- [ ] **Step 4: Run focused tests and verify GREEN**

### Task 2: Concise Action Labels Across the App

**Files:**
- Modify: action components under `src/features/dashboard`, `src/features/matches`, `src/features/voice`, and `src/features/settings`
- Modify: `src/components/RecoveryBanner.tsx`
- Modify: `src/components/UpdatePrompt.tsx`
- Modify: corresponding component tests

**Interfaces:**
- Consumes: `IconLabel` from Task 1.
- Produces: concise visible labels with full `aria-label` values where context was removed.

- [ ] **Step 1: Add failing tests for representative dashboard, match, voice, settings, recovery, and update actions**
- [ ] **Step 2: Run affected component tests and verify RED**
- [ ] **Step 3: Apply Lucide icons and concise labels, preserving behavior, full accessible names, loading states, and destructive confirmation stages**
- [ ] **Step 4: Run affected component tests and verify GREEN**
- [ ] **Step 5: Run touch-target tests** — `npm test -- src/styles/touchTargets.test.tsx`
- [ ] **Step 6: Commit** — `git commit -m "feat: add compact icon actions"`

### Task 3: Combined Release Gate

**Files:**
- Modify: both implementation plans to mark completed steps

- [ ] **Step 1: Run `npm run typecheck && npm run lint && npm test && npm run build && npm run verify:pwa`**
- [ ] **Step 2: Run `npm run test:e2e -- --project=chromium --project=webkit`**
- [ ] **Step 3: Mark both plans complete and commit** — `git commit -m "docs: complete dashboard and icon improvements"`
- [ ] **Step 4: Integrate into `develop`, push, watch CI and Pages deployment, then smoke-test the live dashboard and routes**

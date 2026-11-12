import { useEffect } from 'react';
import type { VoiceDraft } from '../domain/model';

/**
 * In-memory registry of work that would be lost by a page reload (an in-progress recording, audio not yet
 * persisted, an in-flight provider/confirmation call, unsaved draft-game edits). Pages hold it while such work
 * exists and release it as soon as the work is persisted, finished, or cancelled.
 */
export interface WorkRegistry {
  /** Marks work as in progress; returns an idempotent release function. */
  hold(): () => void;
  isBusy(): boolean;
  /** Notified whenever the busy state may have changed. */
  subscribe(listener: () => void): () => void;
}

export function createWorkRegistry(): WorkRegistry {
  let holds = 0; const listeners = new Set<() => void>();
  const notify = () => { listeners.forEach(listener => { try { listener(); } catch { /* A failing listener must not break holders. */ } }); };
  return {
    hold() {
      holds++; notify(); let released = false;
      return () => { if (released) return; released = true; holds--; notify(); };
    },
    isBusy: () => holds > 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Application-wide registry used by RecordPage/DraftReviewPage and the default update guard. */
export const workRegistry = createWorkRegistry();

/** Holds `registry` for as long as `active` is true and the component is mounted. */
export function useWorkHold(active: boolean, registry: WorkRegistry = workRegistry) {
  useEffect(() => (active ? registry.hold() : undefined), [active, registry]);
}

/**
 * Persisted draft states that are mid-operation: a reload would interrupt provider processing or the
 * confirmation write. `recorded`, `ready`, `waiting-retry` and `error` drafts are fully persisted in IndexedDB
 * with their audio/transcripts and are resumable after a reload, so they do not block an update.
 */
export const UNSAFE_DRAFT_STATES: ReadonlySet<VoiceDraft['state']> = new Set<VoiceDraft['state']>(['processing', 'confirming']);

export type WorkStatus = 'safe' | 'active-work' | 'draft-in-progress' | 'unknown';
export interface UnsafeWorkGuard {
  /** Resolves the current status; never rejects for storage failures (they report `unknown`). */
  check(): Promise<WorkStatus>;
  /** Notified when the status may have changed. */
  subscribe(listener: () => void): () => void;
}

export function createUnsafeWorkGuard({ registry, listDrafts }: { registry: WorkRegistry; listDrafts: () => Promise<Pick<VoiceDraft, 'state'>[]> }): UnsafeWorkGuard {
  return {
    async check() {
      if (registry.isBusy()) return 'active-work';
      let drafts;
      try { drafts = await listDrafts(); } catch { return 'unknown'; }
      if (registry.isBusy()) return 'active-work';
      return drafts.some(draft => UNSAFE_DRAFT_STATES.has(draft.state)) ? 'draft-in-progress' : 'safe';
    },
    subscribe: listener => registry.subscribe(listener),
  };
}

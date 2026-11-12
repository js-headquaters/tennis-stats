import { useEffect } from 'react';

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
 * Only work in flight in THIS session (the in-memory registry) blocks an update. Drafts persisted as `processing` or
 * `confirming` (e.g. left by a crash) are recoverable via Retry/Resume/Discard and must never block "Reload to update".
 */
export type WorkStatus = 'safe' | 'active-work';
export interface UnsafeWorkGuard {
  check(): Promise<WorkStatus>;
  /** Notified when the status may have changed. */
  subscribe(listener: () => void): () => void;
}

export function createUnsafeWorkGuard({ registry }: { registry: WorkRegistry }): UnsafeWorkGuard {
  return {
    check: async () => (registry.isBusy() ? 'active-work' : 'safe'),
    subscribe: listener => registry.subscribe(listener),
  };
}

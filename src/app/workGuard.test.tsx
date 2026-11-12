import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createUnsafeWorkGuard, createWorkRegistry, useWorkHold } from './workGuard';

describe('work registry', () => {
  it('is busy while any hold is outstanding and releases idempotently', () => {
    const registry = createWorkRegistry(); const listener = vi.fn(); registry.subscribe(listener);
    expect(registry.isBusy()).toBe(false);
    const first = registry.hold(); const second = registry.hold();
    expect(registry.isBusy()).toBe(true);
    first(); first();
    expect(registry.isBusy()).toBe(true);
    second();
    expect(registry.isBusy()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('stops notifying after unsubscribe', () => {
    const registry = createWorkRegistry(); const listener = vi.fn(); const unsubscribe = registry.subscribe(listener);
    unsubscribe(); registry.hold()();
    expect(listener).not.toHaveBeenCalled();
  });

  it('holds from a hook while active and releases on change and unmount', () => {
    const registry = createWorkRegistry();
    const hook = renderHook(({ active }) => useWorkHold(active, registry), { initialProps: { active: false } });
    expect(registry.isBusy()).toBe(false);
    hook.rerender({ active: true }); expect(registry.isBusy()).toBe(true);
    hook.rerender({ active: false }); expect(registry.isBusy()).toBe(false);
    hook.rerender({ active: true }); hook.unmount(); expect(registry.isBusy()).toBe(false);
  });
});

describe('unsafe work guard', () => {
  it('is safe when nothing is in flight in this session, even with persisted processing or confirming drafts left by a crash', async () => {
    const listDrafts = vi.fn().mockResolvedValue([{ id: 'p', state: 'processing' }, { id: 'c', state: 'confirming' }]);
    // The guard takes no draft lister: persisted rows never block an update.
    const guard = createUnsafeWorkGuard({ registry: createWorkRegistry(), listDrafts } as Parameters<typeof createUnsafeWorkGuard>[0]);
    expect(await guard.check()).toBe('safe');
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it('reports active in-memory work', async () => {
    const registry = createWorkRegistry(); const release = registry.hold();
    const guard = createUnsafeWorkGuard({ registry });
    expect(await guard.check()).toBe('active-work');
    release();
    expect(await guard.check()).toBe('safe');
  });

  it('notifies subscribers when in-memory work changes', () => {
    const registry = createWorkRegistry(); const guard = createUnsafeWorkGuard({ registry }); const listener = vi.fn();
    const unsubscribe = guard.subscribe(listener);
    act(() => { registry.hold()(); });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

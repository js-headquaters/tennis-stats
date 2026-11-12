import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceDraft } from '../domain/model';
import { createUnsafeWorkGuard, createWorkRegistry, UNSAFE_DRAFT_STATES, useWorkHold } from './workGuard';

const draft = (state: VoiceDraft['state']) => ({ id: state, state }) as VoiceDraft;

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
  it('treats only processing and confirming drafts as unsafe', () => {
    expect([...UNSAFE_DRAFT_STATES].sort()).toEqual(['confirming', 'processing']);
  });

  it('reports active in-memory work before consulting storage', async () => {
    const registry = createWorkRegistry(); const listDrafts = vi.fn().mockResolvedValue([]);
    registry.hold();
    expect(await createUnsafeWorkGuard({ registry, listDrafts }).check()).toBe('active-work');
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it('is safe with only persisted recorded, ready, waiting-retry and error drafts', async () => {
    const guard = createUnsafeWorkGuard({ registry: createWorkRegistry(), listDrafts: async () => ['recorded', 'ready', 'waiting-retry', 'error'].map(state => draft(state as VoiceDraft['state'])) });
    expect(await guard.check()).toBe('safe');
  });

  it.each(['processing', 'confirming'] as const)('is unsafe with a %s draft', async state => {
    const guard = createUnsafeWorkGuard({ registry: createWorkRegistry(), listDrafts: async () => [draft('ready'), draft(state)] });
    expect(await guard.check()).toBe('draft-in-progress');
  });

  it('fails closed when drafts cannot be listed', async () => {
    const guard = createUnsafeWorkGuard({ registry: createWorkRegistry(), listDrafts: () => Promise.reject(new Error('secret')) });
    expect(await guard.check()).toBe('unknown');
  });

  it('notifies subscribers when in-memory work changes', () => {
    const registry = createWorkRegistry(); const guard = createUnsafeWorkGuard({ registry, listDrafts: async () => [] }); const listener = vi.fn();
    const unsubscribe = guard.subscribe(listener);
    act(() => { registry.hold()(); });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

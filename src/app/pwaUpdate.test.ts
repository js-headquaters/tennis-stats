import { describe, expect, it, vi } from 'vitest';
import type { RegisterSWOptions } from 'virtual:pwa-register';
import { createPwaUpdateController } from './pwaUpdate';

function setup(updateSW = vi.fn<(reloadPage?: boolean) => Promise<void>>(async () => {})) {
  let options: RegisterSWOptions = {};
  const registerSW = vi.fn((given: RegisterSWOptions = {}) => { options = given; return updateSW; });
  const reload = vi.fn();
  const timers: (() => void)[] = [];
  const setTimer = vi.fn((callback: () => void) => { timers.push(callback); });
  const controller = createPwaUpdateController({ registerSW, reload, setTimer, activationTimeoutMs: 50 });
  return { controller, registerSW, options: () => options, updateSW, reload, timers };
}

describe('createPwaUpdateController', () => {
  it('registers once, without immediate activation, and starts with no update', () => {
    const { controller, registerSW, options, updateSW, reload } = setup();
    expect(registerSW).toHaveBeenCalledTimes(1);
    expect(options().immediate).not.toBe(true);
    expect(controller.getNeedRefresh()).toBe(false);
    expect(updateSW).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('notifies subscribers when an update is waiting, without activating it', () => {
    const { controller, options, updateSW, reload } = setup();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    options().onNeedRefresh?.();
    expect(controller.getNeedRefresh()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    options().onNeedRefresh?.();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(updateSW).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('offline-ready alone does not announce an update', () => {
    const { controller, options } = setup();
    options().onOfflineReady?.();
    expect(controller.getNeedRefresh()).toBe(false);
  });

  it('applyUpdate asks the waiting worker to activate and reloads once it takes control', async () => {
    const { controller, options, updateSW, reload } = setup();
    options().onNeedRefresh?.();
    const result = controller.applyUpdate();
    await Promise.resolve(); await Promise.resolve();
    expect(updateSW).toHaveBeenCalledWith(true);
    expect(reload).not.toHaveBeenCalled();
    options().onNeedReload?.();
    await result;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when another tab activated the update; it re-prompts instead', () => {
    const { controller, options, reload } = setup();
    const listener = vi.fn();
    controller.subscribe(listener);
    options().onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();
    expect(controller.getNeedRefresh()).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it('after a foreign activation, applyUpdate reloads directly (no waiting worker left)', async () => {
    const { controller, options, updateSW, reload } = setup();
    options().onNeedReload?.();
    await controller.applyUpdate();
    expect(updateSW).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects when activation fails so the UI can offer a retry', async () => {
    const { controller, options } = setup(vi.fn(async () => { throw new Error('boom'); }));
    options().onNeedRefresh?.();
    await expect(controller.applyUpdate()).rejects.toThrow();
  });

  it('rejects when the new version never takes control within the timeout', async () => {
    const { controller, options, timers, reload } = setup();
    options().onNeedRefresh?.();
    const result = controller.applyUpdate();
    await Promise.resolve(); await Promise.resolve();
    expect(timers).toHaveLength(1);
    timers[0]();
    await expect(result).rejects.toThrow(/did not activate/);
    options().onNeedReload?.();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a registration error leaves the app usable with no update', () => {
    const { controller, options } = setup();
    options().onRegisterError?.(new Error('no sw'));
    expect(controller.getNeedRefresh()).toBe(false);
  });
});

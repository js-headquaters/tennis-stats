import { describe, expect, it, vi } from 'vitest';
import { createBrowserConnectivity, getUpdateController, noopUpdateController, registerUpdateController, type UpdateController } from './pwa';

describe('browser connectivity source', () => {
  it('reads onLine and notifies on online/offline events until unsubscribed', () => {
    const target = new EventTarget(); const navigatorLike = { onLine: true };
    const source = createBrowserConnectivity({ target, navigator: navigatorLike });
    const listener = vi.fn(); const unsubscribe = source.subscribe(listener);
    expect(source.isOnline()).toBe(true);
    navigatorLike.onLine = false; target.dispatchEvent(new Event('offline'));
    expect(source.isOnline()).toBe(false); expect(listener).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('online')); expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe(); target.dispatchEvent(new Event('online')); expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('update controller registration', () => {
  it('defaults to a no-op controller that never reports an update', async () => {
    expect(getUpdateController()).toBe(noopUpdateController);
    expect(noopUpdateController.getNeedRefresh()).toBe(false);
    const unsubscribe = noopUpdateController.subscribe(() => {}); unsubscribe();
    await expect(noopUpdateController.applyUpdate()).resolves.toBeUndefined();
  });

  it('returns a registered controller', () => {
    const controller: UpdateController = { getNeedRefresh: () => true, subscribe: () => () => {}, applyUpdate: async () => {} };
    registerUpdateController(controller);
    expect(getUpdateController()).toBe(controller);
    registerUpdateController(noopUpdateController);
  });
});

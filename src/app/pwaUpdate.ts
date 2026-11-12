import type { RegisterSWOptions } from 'virtual:pwa-register';
import type { UpdateController } from './pwa';

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export interface PwaUpdateControllerOptions {
  /** `registerSW` from `virtual:pwa-register` (injected so tests never need the virtual module). */
  registerSW: RegisterSW;
  reload?: () => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** How long to wait for the new worker to take control before reporting failure (the UI then offers a retry). */
  activationTimeoutMs?: number;
}

/**
 * `UpdateController` over vite-plugin-pwa's prompt-mode registration.
 *
 * - `onNeedRefresh` only flips `getNeedRefresh()`; nothing activates or reloads by itself.
 * - `applyUpdate()` (called by UpdatePrompt after an explicit tap, once the work guard says it is safe) posts
 *   SKIP_WAITING via `updateSW(true)`, then reloads when the new worker takes control (`onNeedReload`).
 * - If another tab activated the update, this tab is NOT reloaded behind the user's back (it may be recording);
 *   it re-shows the prompt and a later `applyUpdate()` just reloads.
 */
export function createPwaUpdateController({
  registerSW,
  reload = () => window.location.reload(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  activationTimeoutMs = 15_000,
}: PwaUpdateControllerOptions): UpdateController {
  let needRefresh = false;
  let activatedElsewhere = false;
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const listeners = new Set<() => void>();
  const announce = () => { needRefresh = true; listeners.forEach((listener) => listener()); };

  const updateSW = registerSW({
    onNeedRefresh: announce,
    onNeedReload() {
      if (pending) {
        const { resolve } = pending; pending = undefined;
        reload(); resolve();
        return;
      }
      activatedElsewhere = true;
      announce();
    },
    onRegisterError() { /* no service worker: the app keeps working online, no update prompt */ },
  });

  return {
    getNeedRefresh: () => needRefresh,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async applyUpdate() {
      if (activatedElsewhere) { reload(); return; }
      if (pending) throw new Error('An update is already being applied.');
      const activated = new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
      try {
        await updateSW(true);
      } catch {
        pending = undefined;
        throw new Error('The update could not be applied.');
      }
      setTimer(() => {
        if (!pending) return;
        const { reject } = pending; pending = undefined;
        reject(new Error('The new version did not activate.'));
      }, activationTimeoutMs);
      return activated;
    },
  };
}

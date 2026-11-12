import { createUnsafeWorkGuard, workRegistry, type UnsafeWorkGuard } from './workGuard';

/**
 * Service-worker update lifecycle as seen by the UI. Implementations MUST NOT activate or reload on their own:
 * the waiting worker is activated only through `applyUpdate()`, which the UI calls after an explicit user action
 * and only when no unsaved work is at risk.
 */
export interface UpdateController {
  /** True once a new version is installed and waiting. Must return a stable value between notifications. */
  getNeedRefresh(): boolean;
  /** Notified when `getNeedRefresh()` may have changed. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Activates the waiting version and reloads the page. Rejects if activation fails (the UI then allows a retry). */
  applyUpdate(): Promise<void>;
}

export const noopUpdateController: UpdateController = {
  getNeedRefresh: () => false,
  subscribe: () => () => {},
  applyUpdate: async () => {},
};

let currentUpdateController: UpdateController = noopUpdateController;
/** Called once from `main.tsx` before the first render to supply the real (service-worker backed) controller. */
export function registerUpdateController(controller: UpdateController) { currentUpdateController = controller; }
export function getUpdateController(): UpdateController { return currentUpdateController; }

export interface ConnectivitySource {
  isOnline(): boolean;
  /** Notified on `online`/`offline` events. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export function createBrowserConnectivity({ target = window, navigator: nav = window.navigator }: { target?: EventTarget; navigator?: { onLine: boolean } } = {}): ConnectivitySource {
  return {
    isOnline: () => nav.onLine !== false,
    subscribe(listener) {
      target.addEventListener('online', listener); target.addEventListener('offline', listener);
      return () => { target.removeEventListener('online', listener); target.removeEventListener('offline', listener); };
    },
  };
}

let browserConnectivity: ConnectivitySource | undefined;
export function getBrowserConnectivity() { return browserConnectivity ??= createBrowserConnectivity(); }

let defaultWorkGuard: UnsafeWorkGuard | undefined;
/** Guard over the app-wide in-memory work registry (persisted drafts never block an update). */
export function getDefaultWorkGuard() {
  return defaultWorkGuard ??= createUnsafeWorkGuard({ registry: workRegistry });
}

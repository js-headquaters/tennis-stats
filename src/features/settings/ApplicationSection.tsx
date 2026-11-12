import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getBrowserConnectivity, type ConnectivitySource } from '../../app/pwa';
import { dependencies } from '../../app/dependencies';
import type { TennisRepository } from '../../application/ports';
import { APP_VERSION } from '../../infrastructure/appVersion';
import { DATA_VERSION } from '../../infrastructure/db/migrations';

export type ServiceWorkerStatus = 'ready' | 'registering' | 'not-supported' | 'unavailable';
export interface ApplicationSources {
  connectivity?: ConnectivitySource;
  /** True when running as an installed (standalone / Home Screen) app. */
  isStandalone?: () => boolean;
  /** Read-only service-worker state; must never throw (rejection is shown as "unavailable"). */
  serviceWorkerStatus?: () => Promise<ServiceWorkerStatus>;
  appVersion?: string | null;
  dataVersion?: number;
  /** Reads the stored data version without writing; rejects/null => "unavailable". */
  loadStoredVersion?: () => Promise<number | null>;
  /** Borrowed repository for the default stored-version loader (never closed here). */
  repository?: TennisRepository;
}

export function browserIsStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { return false; }
}
export async function browserServiceWorkerStatus(): Promise<ServiceWorkerStatus> {
  if (!('serviceWorker' in navigator)) return 'not-supported';
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return 'unavailable';
  if (registration.active) return 'ready';
  return registration.installing || registration.waiting ? 'registering' : 'unavailable';
}
async function defaultStoredVersion(repository?: TennisRepository): Promise<number | null> {
  let owned: TennisRepository | undefined;
  try {
    const repo = repository ?? (owned = await dependencies.openDatabase());
    const status = repo.getRecoveryStatus();
    if (status.mode === 'readOnly' && status.diagnostics.storedDataVersion !== null) return status.diagnostics.storedDataVersion;
    return (await repo.snapshot()).dataVersion;
  } finally { owned?.close(); }
}
const swText: Record<ServiceWorkerStatus, string> = {
  ready: 'Ready — the app can open offline',
  registering: 'Registering — offline use is not ready yet',
  'not-supported': 'Not supported in this browser — offline use is unavailable',
  unavailable: 'Unavailable — offline use is not ready',
};

/** Purely informational: not part of the page-wide busy lock and never disabled by it. */
export function ApplicationSection({ connectivity = getBrowserConnectivity(), isStandalone = browserIsStandalone, serviceWorkerStatus = browserServiceWorkerStatus, appVersion = APP_VERSION, dataVersion = DATA_VERSION, loadStoredVersion, repository }: ApplicationSources) {
  const subscribe = useCallback((listener: () => void) => connectivity.subscribe(listener), [connectivity]);
  const online = useSyncExternalStore(subscribe, () => connectivity.isOnline(), () => true);
  const [stored, setStored] = useState<number | null | 'loading'>('loading');
  const [sw, setSw] = useState<ServiceWorkerStatus | 'loading'>('loading');
  const [standalone] = useState(() => { try { return isStandalone(); } catch { return false; } });
  useEffect(() => {
    let cancelled = false;
    (loadStoredVersion ?? (() => defaultStoredVersion(repository)))().then(v => { if (!cancelled) setStored(v); }, () => { if (!cancelled) setStored(null); });
    return () => { cancelled = true; };
  }, [loadStoredVersion, repository]);
  useEffect(() => {
    let cancelled = false;
    serviceWorkerStatus().then(v => { if (!cancelled) setSw(v); }, () => { if (!cancelled) setSw('unavailable'); });
    return () => { cancelled = true; };
  }, [serviceWorkerStatus]);
  const storedText = stored === 'loading' ? 'checking…' : stored === null ? 'unavailable' : String(stored);
  return <section aria-labelledby="application-heading" className="application-settings">
    <h2 id="application-heading">Application</h2>
    <dl>
      <dt>App version</dt><dd>{appVersion ?? 'unknown'}</dd>
      <dt>Data (schema) version</dt><dd>App expects {dataVersion}, stored {storedText}{typeof stored === 'number' && stored !== dataVersion ? ' (differs from what the app expects)' : ''}</dd>
      <dt>Network status</dt><dd aria-live="polite">{online ? 'Online' : 'Offline'}</dd>
      <dt>Installed</dt><dd>{standalone ? 'Yes — running as an installed app' : 'No — running in the browser. On iPhone: tap Share → Add to Home Screen.'}</dd>
      <dt>Offline readiness</dt><dd>{sw === 'loading' ? 'Checking…' : swText[sw]}</dd>
    </dl>
  </section>;
}

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getBrowserConnectivity, type ConnectivitySource } from '../../app/pwa';
import { dependencies } from '../../app/dependencies';
import type { RecoveryStatus } from '../../application/ports';
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
  /** Same loader AppShell uses for the recovery banner; this section never opens the database itself. Rejection => "unavailable". */
  loadRecoveryStatus?: () => Promise<RecoveryStatus>;
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
const swText: Record<ServiceWorkerStatus, string> = {
  ready: 'Service worker active — the app can work offline',
  registering: 'Registering — offline use is not ready yet',
  'not-supported': 'Not supported in this browser — offline use is unavailable',
  unavailable: 'Unavailable — offline use is not ready',
};

/** Purely informational: not part of the page-wide busy lock and never disabled by it. */
export function ApplicationSection({ connectivity = getBrowserConnectivity(), isStandalone = browserIsStandalone, serviceWorkerStatus = browserServiceWorkerStatus, appVersion = APP_VERSION, dataVersion = DATA_VERSION, loadRecoveryStatus = dependencies.loadRecoveryStatus }: ApplicationSources) {
  const subscribe = useCallback((listener: () => void) => connectivity.subscribe(listener), [connectivity]);
  const online = useSyncExternalStore(subscribe, () => connectivity.isOnline(), () => true);
  const [stored, setStored] = useState<RecoveryStatus | null | 'loading'>('loading');
  const [sw, setSw] = useState<ServiceWorkerStatus | 'loading'>('loading');
  const [standalone] = useState(() => { try { return isStandalone(); } catch { return false; } });
  useEffect(() => {
    let cancelled = false;
    loadRecoveryStatus().then(v => { if (!cancelled) setStored(v); }, () => { if (!cancelled) setStored(null); });
    return () => { cancelled = true; };
  }, [loadRecoveryStatus]);
  useEffect(() => {
    let cancelled = false;
    serviceWorkerStatus().then(v => { if (!cancelled) setSw(v); }, () => { if (!cancelled) setSw('unavailable'); });
    return () => { cancelled = true; };
  }, [serviceWorkerStatus]);
  const versionText = stored === 'loading' ? `App expects ${dataVersion}, stored: checking…`
    : stored === null ? `App expects ${dataVersion}, stored: unavailable`
    : stored.mode === 'normal' ? `Data version ${dataVersion} (up to date)`
    : `App expects ${dataVersion}, stored ${stored.diagnostics.storedDataVersion ?? 'unavailable'} — the app is read-only until this is resolved`;
  return <section aria-labelledby="application-heading" className="application-settings">
    <h2 id="application-heading">Application</h2>
    <dl>
      <dt>App version</dt><dd>{appVersion ?? 'unknown'}</dd>
      <dt>Data (schema) version</dt><dd>{versionText}</dd>
      <dt>Network status</dt><dd aria-live="polite">{online ? 'Online' : 'Offline'}</dd>
      <dt>Installed</dt><dd>{standalone ? 'Yes — running as an installed app' : 'No — running in the browser. On iPhone: tap Share → Add to Home Screen.'}</dd>
      <dt>Offline readiness</dt><dd>{sw === 'loading' ? 'Checking…' : swText[sw]}</dd>
    </dl>
  </section>;
}

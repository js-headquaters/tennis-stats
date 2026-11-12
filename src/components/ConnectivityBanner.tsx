import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getBrowserConnectivity, type ConnectivitySource } from '../app/pwa';

type Scheduler = { schedule(action: () => void, delay: number): () => void };
const defaultScheduler: Scheduler = { schedule(action, delay) { const id = setTimeout(action, delay); return () => clearTimeout(id); } };
const BACK_ONLINE_MS = 5000;

type Props = { connectivity?: ConnectivitySource; scheduler?: Scheduler };

export default function ConnectivityBanner({ connectivity = getBrowserConnectivity(), scheduler = defaultScheduler }: Props) {
  const subscribe = useCallback((listener: () => void) => connectivity.subscribe(listener), [connectivity]);
  const online = useSyncExternalStore(subscribe, () => connectivity.isOnline(), () => true);
  const [backOnline, setBackOnline] = useState(false);
  const wasOnline = useRef(online); const schedulerRef = useRef(scheduler); schedulerRef.current = scheduler;
  useEffect(() => {
    const cameBack = online && !wasOnline.current; wasOnline.current = online;
    if (!cameBack) { if (!online) setBackOnline(false); return; }
    setBackOnline(true);
    // Cleanup on the next connectivity change cancels this timer, so it can never clear a newer offline message.
    return schedulerRef.current.schedule(() => setBackOnline(false), BACK_ONLINE_MS);
  }, [online]);
  return <div className="connectivity-banner" role="status" aria-live="polite" data-state={online ? (backOnline ? 'back-online' : 'online') : 'offline'}>
    {!online
      ? <><strong>You're offline.</strong> Manual entry, editing, history and dashboards still work. AI transcription and parsing are waiting for a connection; recordings and voice drafts stay on this device and can be retried when you're back online.</>
      : backOnline ? <><strong>Back online.</strong> Voice drafts that were waiting can be retried now.</> : null}
  </div>;
}

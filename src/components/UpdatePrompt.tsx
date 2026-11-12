import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { getDefaultWorkGuard, getUpdateController, type UpdateController } from '../app/pwa';
import type { UnsafeWorkGuard, WorkStatus } from '../app/workGuard';

type Props = { controller?: UpdateController; guard?: UnsafeWorkGuard };
type Status = WorkStatus | 'checking';
const reasons: Record<Exclude<Status, 'safe'>, string> = {
  checking: 'Checking for unsaved recordings and drafts…',
  'active-work': 'Finish or save your recording or draft first. Reloading now would lose it.',
  'draft-in-progress': 'A voice draft is still processing or confirming. Wait for it to finish, or open it and retry, before reloading.',
  unknown: 'Could not check for unsaved voice drafts, so reloading is paused to protect your data.',
};

export default function UpdatePrompt({ controller = getUpdateController(), guard = getDefaultWorkGuard() }: Props) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const needRefresh = useSyncExternalStore(subscribe, () => controller.getNeedRefresh(), () => false);
  const [status, setStatus] = useState<Status>('checking');
  const [applying, setApplying] = useState(false); const [failed, setFailed] = useState(false); const [dismissed, setDismissed] = useState(false);
  const lock = useRef(false); const sequence = useRef(0); const alive = useRef(true);
  const reasonId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const evaluate = useCallback(async (): Promise<Status> => {
    const id = ++sequence.current; setStatus('checking');
    let next: WorkStatus;
    try { next = await guard.check(); } catch { next = 'unknown'; }
    if (alive.current && id === sequence.current) setStatus(next);
    return next;
  }, [guard]);
  useEffect(() => {
    if (!needRefresh) return;
    void evaluate();
    return guard.subscribe(() => { void evaluate(); });
  }, [needRefresh, guard, evaluate]);
  async function reload() {
    if (lock.current) return; lock.current = true; setApplying(true); setFailed(false);
    try {
      // Re-check at click time: work may have started since the last evaluation.
      if (await evaluate() !== 'safe') return;
      await controller.applyUpdate();
    } catch { if (alive.current) setFailed(true); }
    finally { lock.current = false; if (alive.current) setApplying(false); }
  }
  if (!needRefresh || dismissed) return null;
  const reason = status === 'safe' ? '' : reasons[status];
  return <section className="update-prompt" aria-label="App update">
    <p role="status" aria-live="polite"><strong>An update is available.</strong> Reload to start using the new version.</p>
    {reason && <p id={reasonId}>{reason}</p>}
    {failed && <p role="alert">The update could not be applied. Your data is unchanged; try again.</p>}
    <div className="update-actions">
      <button type="button" disabled={applying || status !== 'safe'} aria-describedby={reason ? reasonId : undefined} onClick={() => void reload()}>Reload to update</button>
      {status === 'unknown' && <button type="button" onClick={() => void evaluate()}>Check again</button>}
      <button type="button" onClick={() => setDismissed(true)}>Later</button>
    </div>
  </section>;
}

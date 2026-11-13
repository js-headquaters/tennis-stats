import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecoveryStatus } from '../application/ports';
import { Copy, Download, RefreshCw } from 'lucide-react';
import IconLabel from './IconLabel';

/** Testable clipboard boundary; the default is the browser clipboard, which may be missing or refuse. */
export interface ClipboardWriter { writeText(text: string): Promise<void> }
const browserClipboard: ClipboardWriter = {
  async writeText(text) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
  },
};

type Props = { status: RecoveryStatus | undefined; clipboard?: ClipboardWriter; reload?: () => void };
type Copy = 'idle' | 'copied' | 'failed';

/** Persistent explanation of read-only recovery mode: what happened, what is off, and the safe actions left. */
export default function RecoveryBanner({ status, clipboard = browserClipboard, reload = () => window.location.reload() }: Props) {
  const [copy, setCopy] = useState<Copy>('idle');
  const headingId = useId(); const boxId = useId();
  if (status?.mode !== 'readOnly') return null;
  const text = JSON.stringify(status.diagnostics, null, 2);
  const copyDiagnostics = async () => {
    try { await clipboard.writeText(text); setCopy('copied'); } catch { setCopy('failed'); }
  };
  return <section className="recovery-banner" aria-labelledby={headingId}>
    <h2 id={headingId}>Read-only recovery mode</h2>
    <p role="alert">Your saved data could not be upgraded for this version of the app. Nothing was deleted: your data is preserved on this device.</p>
    <p>The app is read-only until this is fixed: starting matches, adding or editing games, recording, importing and clearing data are turned off. Viewing and exporting still work.</p>
    <p>Reason: {status.diagnostics.message}</p>
    <div className="recovery-actions">
      <Link className="touch-link" aria-label="Export a backup in Settings" to="/settings"><IconLabel icon={Download}>Backup</IconLabel></Link>
      <button type="button" aria-label="Copy diagnostics" onClick={() => void copyDiagnostics()}><IconLabel icon={Copy}>Copy</IconLabel></button>
      <button type="button" aria-label="Reload to retry the upgrade" onClick={reload}><IconLabel icon={RefreshCw}>Retry</IconLabel></button>
    </div>
    <p role="status">{copy === 'copied' ? 'Diagnostics copied.' : copy === 'failed' ? "Couldn't copy automatically. Select and copy the diagnostics below." : ''}</p>
    {copy === 'failed' && <><label htmlFor={boxId}>Diagnostics</label><textarea id={boxId} readOnly rows={10} value={text} onFocus={event => event.currentTarget.select()} /></>}
  </section>;
}

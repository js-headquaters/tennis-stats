import { useCallback, useEffect, useState } from 'react';
import { dependencies } from '../../app/dependencies';
import type { Clock, TennisRepository } from '../../application/ports';
import { backupFileName, exportBackup, serializeBackup, type ClearedCounts } from '../../application/backupService';
import { createBrowserFileTransfer, FileTransferError, type FileTransfer } from '../../infrastructure/backup/fileTransfer';
import { count, countsText } from './dataLabels';
import { ImportPanel } from './ImportPanel';
import { ClearDataPanel } from './ClearDataPanel';
import { Download, RefreshCw } from 'lucide-react';
import IconLabel from '../../components/IconLabel';

export interface DataDeps {
  /** Borrowed repository (never closed here). Without it, each data action opens and closes the app database. */
  repository?: TennisRepository;
  clock?: Clock;
  transfer?: FileTransfer;
}
/** Runs a data task under the page-wide settings lock; ignored when another settings action is in flight. */
export type Exclusive = (task: () => Promise<void>) => void;
export type WithRepository = <T>(task: (repo: TennisRepository) => Promise<T>) => Promise<T>;

async function countRecords(repo: TennisRepository): Promise<ClearedCounts> {
  const s = await repo.snapshot();
  return { opponents: s.opponents.length, matches: s.matches.length, sets: s.sets.length, games: s.games.length, tieBreaks: s.tieBreaks.length, voiceDrafts: s.voiceDrafts.length };
}

export function DataSettingsSection({ deps = {}, pending, acquire, release }: { deps?: DataDeps; pending: boolean; acquire: (owner: 'data') => boolean; release: (owner: 'data') => void }) {
  const { repository } = deps; const clock = deps.clock ?? dependencies.clock;
  const [transfer] = useState(() => deps.transfer ?? createBrowserFileTransfer());
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<ClearedCounts | 'failed'>();
  const [revision, setRevision] = useState(0);
  const [clearEpoch, setClearEpoch] = useState(0);
  const [readOnly, setReadOnly] = useState(false);
  const [exported, setExported] = useState<{ error: boolean; text: string } | null>(null);

  const withRepository: WithRepository = useCallback(async task => {
    let owned: TennisRepository | undefined;
    try { return await task(repository ?? (owned = await dependencies.openDatabase())); }
    finally { owned?.close(); }
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    withRepository(async repo => ({ counts: await countRecords(repo), readOnly: repo.getRecoveryStatus().mode === 'readOnly' }))
      .then(value => { if (!cancelled) { setCounts(value.counts); setReadOnly(value.readOnly); } }, () => { if (!cancelled) setCounts('failed'); });
    return () => { cancelled = true; };
  }, [withRepository, revision]);

  const exclusive: Exclusive = task => {
    if (!acquire('data')) return;
    setBusy(true);
    void task().finally(() => { release('data'); setBusy(false); });
  };
  const changed = () => setRevision(value => value + 1);

  const exportFile = () => exclusive(async () => {
    setExported(null);
    try {
      const now = clock.now();
      const backup = await withRepository(repo => exportBackup(repo, { now: () => now }));
      const fileName = backupFileName(now);
      transfer.download(fileName, serializeBackup(backup));
      setExported({ error: false, text: `Backup saved as ${fileName} (${count(backup.data.matches.length, 'match', 'matches')}, ${count(backup.data.opponents.length, 'opponent', 'opponents')}). It does not include API keys, AI provider settings, or pending voice recordings and drafts.` });
    } catch (reason) {
      setExported({ error: true, text: `Couldn't export the backup. ${reason instanceof FileTransferError ? `${reason.message} ` : ''}Your data was not changed. Try again.` });
    }
  });

  return <fieldset disabled={pending} className="data-settings"><legend>Data</legend>
    {counts === undefined && <p>Counting data on this device…</p>}
    {counts === 'failed' && <><p role="alert">Couldn&apos;t read the data on this device.</p><button type="button" aria-label="Retry counting data" onClick={changed}><IconLabel icon={RefreshCw}>Retry</IconLabel></button></>}
    {counts !== undefined && counts !== 'failed' && <p>On this device: {countsText(counts)}.</p>}
    {busy && <p role="status">Working… Other settings actions are paused until this finishes.</p>}
    {pending && !busy && <p>Another settings action is in progress; data actions are paused until it finishes.</p>}
    <section aria-labelledby="export-backup-heading">
      <h3 id="export-backup-heading">Export backup</h3>
      <p>Backups contain your opponents, matches, sets, games, tie-breaks and comments. They never include API keys, AI provider settings, or pending voice recordings and drafts.</p>
      <button type="button" aria-label="Export backup" onClick={exportFile}><IconLabel icon={Download}>Export</IconLabel></button>
      {exported && <p role={exported.error ? 'alert' : 'status'}>{exported.text}</p>}
    </section>
    <ImportPanel key={clearEpoch} transfer={transfer} exclusive={exclusive} withRepository={withRepository} onChanged={changed} readOnly={readOnly} />
    <ClearDataPanel readOnly={readOnly} exclusive={exclusive} withRepository={withRepository} onChanged={() => { changed(); setClearEpoch(value => value + 1); }} />
  </fieldset>;
}

import { useState } from 'react';
import { applyImport, previewImport, previewMerge, type ImportMode, type ImportPreviewOk, type ImportResult, type MergePlan } from '../../application/backupService';
import { FileTransferError, type FileTransfer } from '../../infrastructure/backup/fileTransfer';
import type { Exclusive, WithRepository } from './DataSettingsSection';
import { count, DISPLAY_ORDER } from './dataLabels';
import { PreviewReport, ResultReport } from './ImportReport';
import ReadOnlyNotice from '../../components/ReadOnlyNotice';
import { isReadOnlyRecoveryError, READ_ONLY_MESSAGE } from '../../application/recovery';

type Stage =
  | { kind: 'idle' }
  | { kind: 'invalid'; message: string }
  | { kind: 'preview'; preview: ImportPreviewOk; plan: MergePlan | null; confirm: ImportMode | null; error: string | null }
  | { kind: 'done'; result: ImportResult };

const UNCHANGED = 'Your current data was not changed.';
const accepted = (preview: ImportPreviewOk) => DISPLAY_ORDER.reduce((sum, entity) => sum + preview.counts[entity].accepted, 0);

export function ImportPanel({ transfer, exclusive, withRepository, onChanged, readOnly = false }: { transfer: FileTransfer; exclusive: Exclusive; withRepository: WithRepository; onChanged: () => void; readOnly?: boolean }) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [inputKey, setInputKey] = useState(0);
  const resetInput = () => setInputKey(key => key + 1);

  const choose = (file: File | undefined) => { if (file && !readOnly) exclusive(async () => {
    setStage({ kind: 'idle' });
    let text: string;
    try { text = await transfer.readText(file); }
    catch (reason) { resetInput(); setStage({ kind: 'invalid', message: `This file can't be imported: ${reason instanceof FileTransferError ? reason.message : 'it could not be read.'} ${UNCHANGED}` }); return; }
    const preview = previewImport(text);
    if (!preview.ok) { resetInput(); setStage({ kind: 'invalid', message: `This file can't be imported: ${preview.error} ${UNCHANGED}` }); return; }
    const plan = await withRepository(repo => previewMerge(preview, repo)).catch((): MergePlan | null => null);
    setStage({ kind: 'preview', preview, plan, confirm: null, error: null });
  }); };

  const apply = (preview: ImportPreviewOk, plan: MergePlan | null, mode: ImportMode) => exclusive(async () => {
    try {
      const result = await withRepository(repo => applyImport(preview, mode, repo));
      resetInput(); setStage({ kind: 'done', result }); onChanged();
    } catch (reason) {
      setStage({ kind: 'preview', preview, plan, confirm: null, error: isReadOnlyRecoveryError(reason) ? `Couldn't import the backup. ${READ_ONLY_MESSAGE}` : `Couldn't import the backup. ${UNCHANGED} Try again or choose another file.` });
    }
  });

  const cancel = () => { resetInput(); setStage({ kind: 'idle' }); };
  return <section aria-labelledby="import-backup-heading">
    <h3 id="import-backup-heading">Import backup</h3>
    <p>Choose a Tennis Stats backup file (.json). You will see what it contains and choose merge or replace before anything changes.</p>
    {readOnly && <ReadOnlyNotice disabled="importing is" />}
    <label>Backup file to import <input key={inputKey} disabled={readOnly} type="file" accept=".json,application/json" onChange={event => choose(event.target.files?.[0])} /></label>
    {stage.kind === 'invalid' && <p role="alert">{stage.message}</p>}
    {stage.kind === 'done' && <ResultReport result={stage.result} />}
    {stage.kind === 'preview' && <section aria-label="Import preview">
      <h4>Import preview</h4>
      <PreviewReport preview={stage.preview} plan={stage.plan} />
      {stage.error && <p role="alert">{stage.error}</p>}
      {accepted(stage.preview) === 0 && <p>Nothing in this file can be imported.</p>}
      {stage.confirm === null
        ? <div className="data-actions">
          <button type="button" disabled={stage.plan === null || accepted(stage.preview) === 0} onClick={() => setStage({ ...stage, confirm: 'merge', error: null })}>Merge into current data</button>
          <button type="button" disabled={accepted(stage.preview) === 0} onClick={() => setStage({ ...stage, confirm: 'replace', error: null })}>Replace current data</button>
          <button type="button" onClick={cancel}>Cancel import</button>
        </div>
        : <section aria-label={stage.confirm === 'merge' ? 'Confirm merge' : 'Confirm replace'} className="data-confirm">
          {stage.confirm === 'merge'
            ? <p>Merge adds the new records from this file to the data on this device. Existing records are never changed; conflicting records are skipped.{stage.plan ? ` ${count(stage.plan.conflicts.length, 'conflict', 'conflicts')} will be left out.` : ''}</p>
            : <p><strong>Warning:</strong> Replace deletes all matches, opponents, sets, games and tie-breaks currently on this device and replaces them with the {count(accepted(stage.preview), 'accepted record', 'accepted records')} from this file. Pending voice recordings and drafts are discarded unless their match and set are in this file. This cannot be undone; export a backup first if you might need the current data.</p>}
          <div className="data-actions">
            <button type="button" onClick={() => apply(stage.preview, stage.plan, stage.confirm!)}>{stage.confirm === 'merge' ? 'Confirm merge' : 'Confirm replace'}</button>
            <button type="button" onClick={() => setStage({ ...stage, confirm: null })}>Cancel</button>
          </div>
        </section>}
    </section>}
  </section>;
}

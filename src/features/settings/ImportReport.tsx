import type { ImportConflict, ImportPreviewOk, ImportResult, MergePlan, OpponentRemap, RejectedRecord } from '../../application/backupService';
import { capitalize, count, DISPLAY_ORDER, ENTITY_LABEL } from './dataLabels';

function exportedLabel(exportedAt: string | null) {
  if (exportedAt === null) return '';
  const date = new Date(exportedAt);
  return Number.isNaN(date.getTime()) ? '' : `, exported ${date.toLocaleString()}`;
}
const total = (summary: MergePlan['summary'], field: 'added' | 'skipped' | 'conflicted') => DISPLAY_ORDER.reduce((sum, entity) => sum + summary[entity][field], 0);

function RejectedList({ rejected, label }: { rejected: RejectedRecord[]; label: string }) {
  if (!rejected.length) return null;
  return <><h4>{label}</h4><ul aria-label={label}>{rejected.map(item => <li key={`${item.entity}-${item.index}`}>
    {capitalize(ENTITY_LABEL[item.entity].one)} {item.index + 1}{item.id !== null ? ` (${item.id})` : ''}: {item.reasons.join('; ')}
  </li>)}</ul></>;
}
function ConflictList({ conflicts, label }: { conflicts: ImportConflict[]; label: string }) {
  if (!conflicts.length) return null;
  return <><h4>{label}</h4><ul aria-label={label}>{conflicts.map(item => <li key={`${item.entity}-${item.id}`}>{capitalize(ENTITY_LABEL[item.entity].one)} {item.id}: {item.reason}</li>)}</ul></>;
}
function RemapList({ remaps, label }: { remaps: OpponentRemap[]; label: string }) {
  if (!remaps.length) return null;
  return <><h4>{label}</h4><ul aria-label={label}>{remaps.map(item => <li key={`${item.from}-${item.to}`}>Opponent {item.from} is treated as {item.name} ({item.to}).</li>)}</ul></>;
}

export function PreviewReport({ preview, plan }: { preview: ImportPreviewOk; plan: MergePlan | null }) {
  return <>
    <p>Backup format version {preview.sourceVersion}{exportedLabel(preview.exportedAt)}. Nothing has been imported yet.</p>
    <div className="table-scroll"><table>
      <caption>Records in this file</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">In file</th><th scope="col">Accepted</th><th scope="col">Rejected</th></tr></thead>
      <tbody>{DISPLAY_ORDER.map(entity => <tr key={entity}><th scope="row">{ENTITY_LABEL[entity].title}</th><td>{preview.counts[entity].total}</td><td>{preview.counts[entity].accepted}</td><td>{preview.counts[entity].rejected}</td></tr>)}</tbody>
    </table></div>
    {preview.warnings.length > 0 && <><h4>Warnings</h4><ul aria-label="Warnings">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></>}
    <RejectedList rejected={preview.rejected} label="Rejected records" />
    <RemapList remaps={preview.remaps} label="Duplicate opponents in this file" />
    <h4>If you merge</h4>
    {plan === null
      ? <p role="alert">Couldn&apos;t compare this file with the data on this device, so merge is unavailable. Choose the file again to retry.</p>
      : <>
        <p>{count(total(plan.summary, 'added'), 'record', 'records')} would be added, {total(plan.summary, 'skipped')} skipped because they are already on this device, and {count(plan.conflicts.length, 'conflict', 'conflicts')} left out.</p>
        <ConflictList conflicts={plan.conflicts} label="Merge conflicts (not imported)" />
        <RemapList remaps={plan.remaps} label="Opponents matched to existing opponents by name" />
      </>}
  </>;
}

export function ResultReport({ result }: { result: ImportResult }) {
  const drafts = result.mode === 'replace' ? ` ${count(result.draftsKept, 'pending voice draft', 'pending voice drafts')} kept, ${result.draftsDiscarded} discarded.` : '';
  const rejected = result.rejected.length ? ` ${count(result.rejected.length, 'record', 'records')} from the file were rejected and not imported.` : '';
  return <>
    <p role="status" aria-label="Import outcome">{result.mode === 'merge' ? 'Merge' : 'Replace'} finished.{drafts} {count(total(result.summary, 'added'), 'record', 'records')} added, {total(result.summary, 'skipped')} skipped, {total(result.summary, 'conflicted')} not imported because of conflicts.{rejected}</p>
    <div className="table-scroll"><table>
      <caption>Import result</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Added</th><th scope="col">Skipped</th><th scope="col">Conflicted</th></tr></thead>
      <tbody>{DISPLAY_ORDER.map(entity => <tr key={entity}><th scope="row">{ENTITY_LABEL[entity].title}</th><td>{result.summary[entity].added}</td><td>{result.summary[entity].skipped}</td><td>{result.summary[entity].conflicted}</td></tr>)}</tbody>
    </table></div>
    <ConflictList conflicts={result.conflicts} label="Conflicts (not imported)" />
    <RejectedList rejected={result.rejected} label="Rejected records (not imported)" />
  </>;
}

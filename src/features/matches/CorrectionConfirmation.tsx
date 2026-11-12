import type { GameConflict } from '../../application/matchService';

/** Task 7's conflict preview: nothing is saved until the user confirms the affected records. */
export default function CorrectionConfirmation({ conflicts, busy, onConfirm, onCancel }: { conflicts: GameConflict[]; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <section role="region" aria-label="Affected records" className="confirmation"><h2>Confirm affected records</h2><p>This correction affects existing records. Stored servers will not be rewritten.</p>
    <ul>{conflicts.map((c, i) => <li key={i}>{c.message}{c.gameId && ` (game ${c.gameId})`}</li>)}</ul>
    <button disabled={busy} onClick={onConfirm}>Confirm affected records</button> <button disabled={busy} onClick={onCancel}>Cancel correction</button>
  </section>;
}

import type { MatchBundle, MatchDiagnostic } from '../domain/model';

export const DIAGNOSTICS_FORMAT = 'tennis-stats-voice-diagnostics';

/** Builds the voice diagnostics download for one match. Rows are sorted by `startedAt`; no audio is ever included. */
export function buildDiagnosticsExport(bundle: MatchBundle, rows: MatchDiagnostic[], exportedAt: string): { fileName: string; text: string } {
  const { match, opponent } = bundle;
  const diagnostics = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const envelope = { format: DIAGNOSTICS_FORMAT, version: 1, exportedAt, match: { id: match.id, playedAt: match.playedAt, format: match.format, opponent: opponent.name }, diagnostics };
  return { fileName: `${DIAGNOSTICS_FORMAT}-${match.id}-${exportedAt.slice(0, 10)}.json`, text: JSON.stringify(envelope, null, 2) };
}

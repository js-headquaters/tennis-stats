import { expect, it } from 'vitest';
import type { MatchBundle, MatchDiagnostic } from '../domain/model';
import { buildDiagnosticsExport, DIAGNOSTICS_FORMAT } from './diagnosticsExport';

const stamp = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const bundle: MatchBundle = {
  opponent: { ...stamp, id: 'o1', name: 'Alex', normalizedName: 'alex' },
  match: { ...stamp, id: 'm1', opponentId: 'o1', playedAt: '2026-11-10T18:30:00.000Z', format: 'bestOfThree', firstServer: 'player', status: 'completed', comments: null },
  sets: [], games: [], tieBreaks: [],
};
function row(id: string, startedAt: string): MatchDiagnostic {
  return { id, matchId: 'm1', setId: null, draftId: 'd1', phase: 'parser', attempt: 1, provider: 'p', model: 'mod', startedAt, finishedAt: startedAt, outcome: 'success', transcript: null, request: { value: 'req', truncated: false, originalLength: 3 }, response: null, error: null };
}

it('builds a named, sorted, round-trippable export without audio', () => {
  const out = buildDiagnosticsExport(bundle, [row('b', '2026-11-10T10:00:02.000Z'), row('a', '2026-11-10T10:00:01.000Z')], '2026-11-13T23:59:59.000Z');
  expect(out.fileName).toBe('tennis-stats-voice-diagnostics-m1-2026-11-13.json');
  const parsed = JSON.parse(out.text);
  expect(parsed).toMatchObject({ format: DIAGNOSTICS_FORMAT, version: 1, exportedAt: '2026-11-13T23:59:59.000Z', match: { id: 'm1', playedAt: '2026-11-10T18:30:00.000Z', format: 'bestOfThree', opponent: 'Alex' } });
  expect(parsed.diagnostics.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
  expect(out.text).toBe(JSON.stringify(parsed, null, 2));
  expect(out.text).not.toMatch(/audio|recording/i);
});

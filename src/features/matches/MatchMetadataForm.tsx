import { useState } from 'react';
import type { MatchDetailsPatch } from '../../application/matchService';
import type { MatchBundle, MatchFormat } from '../../domain/model';
import { FORMAT_LABEL } from './MatchHistoryPage';
import { localDate } from './StartMatchPage';

function toInstant(local: string) {
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? local : date.toISOString();
}

export default function MatchMetadataForm({ bundle, busy, onSubmit }: { bundle: MatchBundle; busy: boolean; onSubmit: (patch: MatchDetailsPatch) => Promise<void> }) {
  const [initialPlayedAt] = useState(() => localDate(bundle.match.playedAt));
  const [opponent, setOpponent] = useState(bundle.opponent.name);
  const [playedAt, setPlayedAt] = useState(initialPlayedAt);
  const [format, setFormat] = useState<MatchFormat>(bundle.match.format);
  /** Only fields the user changed are sent, so an untouched playedAt keeps its stored precision. */
  function patch(): MatchDetailsPatch {
    const changes: MatchDetailsPatch = {};
    if (opponent !== bundle.opponent.name) changes.opponentName = opponent;
    if (playedAt !== initialPlayedAt) changes.playedAt = toInstant(playedAt);
    if (format !== bundle.match.format) changes.format = format;
    return changes;
  }
  return <form aria-label="Match details" onSubmit={e => { e.preventDefault(); if (!busy) void onSubmit(patch()); }}>
    <h2>Match details</h2>
    <label>Opponent<input value={opponent} onChange={e => setOpponent(e.target.value)} required /></label>
    <label>Date and time<input type="datetime-local" value={playedAt} onChange={e => setPlayedAt(e.target.value)} required /></label>
    <label>Format<select value={format} onChange={e => setFormat(e.target.value as MatchFormat)}>{(Object.keys(FORMAT_LABEL) as MatchFormat[]).map(key => <option key={key} value={key}>{FORMAT_LABEL[key]}</option>)}</select></label>
    <button type="submit" disabled={busy}>Save match details</button>
  </form>;
}

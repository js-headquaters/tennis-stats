import type { Game, RecordedMetric } from '../../domain/model';
import { calculateMetric, RECORDED_METRICS } from '../../domain/statistics';
import { countOf, formatAverage } from '../dashboard/format';

const RECORDED_METRIC_COPY: Record<RecordedMetric, { label: string; per: string; noun: string }> = {
  netErrors: { label: 'Net errors', per: 'per recorded game', noun: 'game' },
  wideErrors: { label: 'Wide errors', per: 'per recorded game', noun: 'game' },
  longErrors: { label: 'Long errors', per: 'per recorded game', noun: 'game' },
  doubleFaults: { label: 'Double faults', per: 'per service game', noun: 'service game' },
  failedReturns: { label: 'Failed returns', per: 'per return game', noun: 'return game' },
};

/** Per-match averages over normal games (tie-breaks excluded, as on the dashboard). Unknown is `—`; zero appears only when recorded. */
export default function MatchAverages({ games }: { games: readonly Game[] }) {
  return <section aria-labelledby="match-averages" className="match-averages"><h2 id="match-averages">Match averages</h2>
    <table aria-label="Match averages per metric"><thead><tr><th scope="col">Metric</th><th scope="col">Average</th><th scope="col">Recorded sample</th></tr></thead>
      <tbody>{RECORDED_METRICS.map(key => {
        const { average, sampleSize } = calculateMetric(games, key); const copy = RECORDED_METRIC_COPY[key];
        return <tr key={key}><th scope="row">{copy.label} <small>{copy.per}</small></th>
          <td>{average === null ? <span role="img" aria-label="unknown">—</span> : formatAverage(average)}</td>
          <td>{countOf(sampleSize, copy.noun)}</td></tr>;
      })}</tbody></table>
  </section>;
}

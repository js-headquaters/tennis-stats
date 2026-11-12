import { useId } from 'react';
import type { RecordedMetric } from '../../domain/model';
import type { MetricComparison } from '../../domain/statistics';
import { countOf, formatAverage } from './format';
import type { PeriodUnit } from './periods';
import TrendChart, { type TrendPoint } from './TrendChart';

export const METRIC_COPY: Record<RecordedMetric, { label: string; per: string; noun: string }> = {
  netErrors: { label: 'Net errors', per: 'per recorded game', noun: 'game' },
  wideErrors: { label: 'Wide errors', per: 'per recorded game', noun: 'game' },
  longErrors: { label: 'Long errors', per: 'per recorded game', noun: 'game' },
  // Double faults only occur in the player's service games, which form the denominator.
  doubleFaults: { label: 'Double faults', per: 'per service game', noun: 'service game' },
  failedReturns: { label: 'Failed returns', per: 'per return game', noun: 'return game' },
};

function trendText({ previous, trend }: MetricComparison, unit: PeriodUnit, noun: string): { glyph: string; text: string } {
  if (trend.state === 'insufficient') {
    const where = trend.reason === 'noCurrent' ? `the selected ${unit}` : trend.reason === 'noPrevious' ? `the previous ${unit}` : `the selected or previous ${unit}`;
    return { glyph: '', text: `No comparison: no recorded ${noun}s in ${where}` };
  }
  const was = `(${formatAverage(previous.average ?? 0)} across ${countOf(previous.sampleSize, noun)})`;
  const difference = formatAverage(Math.abs(trend.difference));
  if (trend.direction === 'unchanged' || difference === '0') return { glyph: '=', text: `Same as the previous ${unit} ${was}` };
  return { glyph: trend.direction === 'lower' ? '↓' : '↑', text: `${difference} ${trend.direction} than the previous ${unit} ${was}` };
}

export default function MetricCard({ metric, unit, comparison, history }: { metric: RecordedMetric; unit: PeriodUnit; comparison: MetricComparison; history: readonly TrendPoint[] }) {
  const id = useId();
  const copy = METRIC_COPY[metric];
  const { average, sampleSize } = comparison.current;
  const trend = trendText(comparison, unit, copy.noun);
  return <article className="metric-card" aria-labelledby={id}>
    <h4 id={id}>{copy.label}</h4>
    <p className="metric-card-per">{copy.per}</p>
    <dl className="metric-card-stats">
      <div><dt>Average</dt><dd className="metric-card-average">{average === null ? <span role="img" aria-label="unknown">—</span> : formatAverage(average)}</dd></div>
      <div><dt>Sample</dt><dd>{countOf(sampleSize, copy.noun)}</dd></div>
      <div className="metric-card-trend"><dt>Trend</dt><dd>{trend.glyph && <span aria-hidden="true">{trend.glyph} </span>}{trend.text}</dd></div>
    </dl>
    {history.length > 0 && <TrendChart title={`${copy.label} ${copy.per}`} sampleNoun={copy.noun} points={history} />}
  </article>;
}

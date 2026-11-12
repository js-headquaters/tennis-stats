import { lazy, Suspense } from 'react';
import { countOf, formatAverage } from './format';

export interface TrendPoint { label: string; shortLabel: string; average: number | null; sampleSize: number }

// Recharts is loaded on demand so it stays out of the initial bundle; the text table renders immediately.
const TrendLines = lazy(() => import('./TrendLines'));

export default function TrendChart({ title, sampleNoun, points }: { title: string; sampleNoun: string; points: readonly TrendPoint[] }) {
  return <figure className="trend-chart" aria-label={`${title} trend`}>
    <Suspense fallback={<div className="trend-chart-visual" aria-hidden="true" />}><TrendLines points={points} /></Suspense>
    <table className="visually-hidden">
      <caption>{title} by period</caption>
      <thead><tr><th scope="col">Period</th><th scope="col">Average</th><th scope="col">Sample</th></tr></thead>
      <tbody>{points.map(point => <tr key={point.label}>
        <th scope="row">{point.label}</th>
        <td>{point.average === null ? <span role="img" aria-label="unknown">—</span> : formatAverage(point.average)}</td>
        <td>{countOf(point.sampleSize, sampleNoun)}</td>
      </tr>)}</tbody>
    </table>
  </figure>;
}

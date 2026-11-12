import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { TrendPoint } from './TrendChart';

const text = '#343a34';
const tick = { fill: text, fontSize: 12 };

/** Visual-only rendering; TrendChart supplies the accessible name and text equivalent. */
export default function TrendLines({ points }: { points: readonly TrendPoint[] }) {
  return <div className="trend-chart-visual" data-testid="trend-chart-visual" aria-hidden="true">
    <ResponsiveContainer width="100%" height={120} initialDimension={{ width: 320, height: 120 }}>
      <LineChart data={[...points]} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} accessibilityLayer={false}>
        <CartesianGrid stroke="#e2e5dc" vertical={false} />
        <XAxis dataKey="shortLabel" tick={tick} stroke="#c9cec2" interval="preserveStartEnd" />
        <YAxis domain={[0, 'auto']} width={32} tick={tick} stroke="#c9cec2" allowDecimals />
        <Line type="linear" dataKey="average" stroke="#52721d" strokeWidth={2} dot={{ r: 4, fill: '#52721d' }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}

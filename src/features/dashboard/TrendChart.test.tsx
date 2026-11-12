import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import TrendChart from './TrendChart';

const points = [
  { label: '26 Oct – 1 Nov 2026', shortLabel: '26 Oct', average: null, sampleSize: 0 },
  { label: '2–8 Nov 2026', shortLabel: '2 Nov', average: 0, sampleSize: 2 },
  { label: '9–15 Nov 2026', shortLabel: '9 Nov', average: 1.5, sampleSize: 1 },
];

it('gives the chart an accessible name and a complete text equivalent', async () => {
  render(<TrendChart title="Net errors per recorded game" sampleNoun="game" points={points} />);
  const figure = screen.getByRole('figure', { name: 'Net errors per recorded game trend' });
  const table = within(figure).getByRole('table', { name: 'Net errors per recorded game by period' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map(row => row.textContent)).toEqual(['26 Oct – 1 Nov 2026—0 games', '2–8 Nov 202602 games','9–15 Nov 20261.51 game']);
  expect(within(rows[0]).getByLabelText('unknown')).toHaveTextContent('—');
  expect(within(rows[1]).getAllByRole('cell')[0]).toHaveTextContent(/^0$/);
  expect(within(rows[2]).getAllByRole('cell')[1]).toHaveTextContent('1 game');
  expect(await within(figure).findByTestId('trend-chart-visual')).toHaveAttribute('aria-hidden', 'true');
});

it('uses return-game sample wording', () => {
  render(<TrendChart title="Failed returns per return game" sampleNoun="return game" points={[points[1]]} />);
  expect(screen.getByRole('cell', { name: '2 return games' })).toBeInTheDocument();
});

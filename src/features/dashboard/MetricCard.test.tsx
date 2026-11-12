import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { MetricComparison } from '../../domain/statistics';
import MetricCard from './MetricCard';

function comparison(current: [number | null, number], previous: [number | null, number], trend: MetricComparison['trend']): MetricComparison {
  return { current: { key: 'netErrors', average: current[0], sampleSize: current[1] }, previous: { key: 'netErrors', average: previous[0], sampleSize: previous[1] }, trend };
}
function value(card: HTMLElement, term: string) {
  const dt = within(card).getByText(term, { selector: 'dt' });
  return dt.nextElementSibling as HTMLElement;
}

it('shows average, sample size and neutral comparison against the previous period', () => {
  render(<MetricCard metric="netErrors" unit="week" comparison={comparison([1.25, 4], [2, 3], { state: 'compared', direction: 'lower', difference: -0.75 })} history={[]} />);
  const card = screen.getByRole('article', { name: 'Net errors' });
  expect(within(card).getByText('per recorded game')).toBeInTheDocument();
  expect(value(card, 'Average')).toHaveTextContent('1.25');
  expect(value(card, 'Sample')).toHaveTextContent('4 games');
  expect(value(card, 'Trend')).toHaveTextContent('0.75 lower than the previous week (2 across 3 games)');
  expect(card).not.toHaveTextContent(/improv|better|worse/i);
});

it('uses return games for failed returns and singular sample wording', () => {
  render(<MetricCard metric="failedReturns" unit="month" comparison={comparison([0, 1], [0, 1], { state: 'compared', direction: 'unchanged', difference: 0 })} history={[]} />);
  const card = screen.getByRole('article', { name: 'Failed returns' });
  expect(within(card).getByText('per return game')).toBeInTheDocument();
  expect(value(card, 'Average')).toHaveTextContent(/^0$/);
  expect(value(card, 'Sample')).toHaveTextContent('1 return game');
  expect(value(card, 'Trend')).toHaveTextContent('Same as the previous month (0 across 1 return game)');
});

it('uses service games for double faults', () => {
  render(<MetricCard metric="doubleFaults" unit="week" comparison={comparison([1, 2], [0.5, 2], { state: 'compared', direction: 'higher', difference: 0.5 })} history={[]} />);
  const card = screen.getByRole('article', { name: 'Double faults' });
  expect(within(card).getByText('per service game')).toBeInTheDocument();
  expect(value(card, 'Sample')).toHaveTextContent('2 service games');
  expect(value(card, 'Trend')).toHaveTextContent('0.5 higher than the previous week (0.5 across 2 service games)');
});

it('shows unknown with an accessible label and an explicit no-comparison message', () => {
  render(<MetricCard metric="wideErrors" unit="week" comparison={comparison([null, 0], [0.5, 2], { state: 'insufficient', reason: 'noCurrent' })} history={[]} />);
  const card = screen.getByRole('article', { name: 'Wide errors' });
  expect(within(value(card, 'Average')).getByLabelText('unknown')).toHaveTextContent('—');
  expect(value(card, 'Sample')).toHaveTextContent('0 games');
  expect(value(card, 'Trend')).toHaveTextContent('No comparison: no recorded games in the selected week');
  expect(value(card, 'Trend')).not.toHaveTextContent(/lower|higher|same/i);
});

it.each([
  ['noPrevious', 'No comparison: no recorded games in the previous week'],
  ['noBoth', 'No comparison: no recorded games in the selected or previous week'],
] as const)('words the %s insufficient state neutrally', (reason, text) => {
  render(<MetricCard metric="longErrors" unit="week" comparison={comparison(reason === 'noBoth' ? [null, 0] : [1, 1], [null, 0], { state: 'insufficient', reason })} history={[]} />);
  expect(value(screen.getByRole('article', { name: 'Long errors' }), 'Trend')).toHaveTextContent(text);
});

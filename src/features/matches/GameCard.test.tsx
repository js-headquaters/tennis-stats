import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Game } from '../../domain/model';
import GameCard from './GameCard';

const base: Game = { id: 'g', setId: 's', ordinal: 1, server: 'player', result: 'won', score: null, netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, createdAt: 'now', updatedAt: 'now' };

it('displays the result, service and detailed values including unknown and zero', () => {
  render(<GameCard game={{ ...base, netErrors: 0, longErrors: 1 }} />);
  expect(screen.getByText('Won')).toBeInTheDocument();
  expect(screen.getByText(/player served/i)).toBeInTheDocument();
  expect(within(screen.getByTestId('metric-netErrors')).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByTestId('metric-wideErrors')).getByLabelText(/unknown/i)).toHaveTextContent('—');
  expect(screen.getByTestId('metric-netErrors').closest('details')).not.toHaveAttribute('open');
});
it('shows the explicit unforced total as authoritative, without a derived note', () => {
  render(<GameCard game={{ ...base, unforcedErrors: 5, netErrors: 1 }} />);
  expect(within(screen.getByTestId('metric-unforcedErrors')).getByText('5')).toBeInTheDocument();
  expect(screen.queryByText('Derived from details')).not.toBeInTheDocument();
});
it('shows an explicit zero total over detail values', () => {
  render(<GameCard game={{ ...base, unforcedErrors: 0, netErrors: 2 }} />);
  expect(within(screen.getByTestId('metric-unforcedErrors')).getByText('0')).toBeInTheDocument();
});
it('labels the fallback sum as Derived from details', () => {
  render(<GameCard game={{ ...base, netErrors: 1, wideErrors: null, longErrors: 2 }} />);
  const metric = screen.getByTestId('metric-unforcedErrors');
  expect(within(metric).getByText('3')).toBeInTheDocument(); expect(within(metric).getByText('Derived from details')).toBeInTheDocument();
});
it('shows unknown unforced errors when nothing is recorded', () => {
  render(<GameCard game={base} />);
  expect(within(screen.getByTestId('metric-unforcedErrors')).getByLabelText('unknown')).toHaveTextContent('—');
});
it('shows only the applicable serve metric', () => {
  const { rerender } = render(<GameCard game={{ ...base, doubleFaults: 2 }} />);
  expect(within(screen.getByTestId('metric-doubleFaults')).getByText('2')).toBeInTheDocument();
  expect(screen.queryByTestId('metric-failedReturns')).not.toBeInTheDocument();
  rerender(<GameCard game={{ ...base, server: 'opponent', failedReturns: 1 }} />);
  expect(screen.getByTestId('metric-failedReturns')).toHaveTextContent('Receive errors1');
  expect(screen.queryByTestId('metric-doubleFaults')).not.toBeInTheDocument();
});
it('renders the game comment when present and omits it otherwise', () => {
  const { rerender } = render(<GameCard game={{ ...base, comments: 'Strong second serve' }} />);
  expect(screen.getByText('Strong second serve')).toBeInTheDocument();
  rerender(<GameCard game={base} />);
  expect(screen.queryByText('Strong second serve')).not.toBeInTheDocument();
});

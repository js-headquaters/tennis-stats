import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Game } from '../../domain/model';
import GameCard from './GameCard';

it('displays the result, service and separate accessible metrics including unknown and zero', () => {
  const game: Game = { id: 'g', setId: 's', ordinal: 1, server: 'player', result: 'won', score: null, netErrors: 0, wideErrors: null, longErrors: 1, doubleFaults: null, failedReturns: null, unforcedErrors: null, comments: null, createdAt: 'now', updatedAt: 'now' };
  render(<GameCard game={game} />);
  expect(screen.getByText('Won')).toBeInTheDocument();
  expect(screen.getByText(/player served/i)).toBeInTheDocument();
  expect(within(screen.getByTestId('metric-netErrors')).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByTestId('metric-wideErrors')).getByLabelText(/unknown/i)).toHaveTextContent('—');
});

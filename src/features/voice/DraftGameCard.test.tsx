import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DraftGameCard from './DraftGameCard';
import type { DraftGame } from '../../domain/model';

const game: DraftGame = { server: 'player', result: 'won', netErrors: 0, wideErrors: null, longErrors: 1, doubleFaults: 2, failedReturns: null, unforcedErrors: null, comments: null };

it('labels each field and distinguishes unknown from zero when saving', () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  expect(screen.getByRole('form', { name: 'Draft game 1' })).toBeInTheDocument();
  expect(screen.getByLabelText('Result')).toHaveDisplayValue('Won');
  expect(screen.getByLabelText('Server')).toHaveDisplayValue('Player served');
  for (const label of ['Net errors', 'Wide errors', 'Long errors', 'Double faults', 'Failed returns']) expect(screen.getByLabelText(label)).toBeInTheDocument();
  expect(within(screen.getByTestId('draft-metric-netErrors')).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByTestId('draft-metric-wideErrors')).getByLabelText(/unknown/i)).toHaveTextContent('—');
  fireEvent.change(screen.getByLabelText('Net errors'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Wide errors'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).toHaveBeenCalledWith(0, expect.objectContaining({ netErrors: null, wideErrors: 0 }));
});

it.each([
  ['opponent', game, 'Failed returns', 'Double faults', 'doubleFaults'],
  ['player', { ...game, server: 'opponent', doubleFaults: null, failedReturns: 3, unforcedErrors: null, comments: null } as DraftGame, 'Double faults', 'Failed returns', 'failedReturns'],
] as const)('clears the incompatible metric when switching to %s', (server, initial, initiallyDisabled, disabled, cleared) => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={initial} index={2} onUpdate={update} />);
  expect(screen.getByLabelText(initiallyDisabled)).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Server'), { target: { value: server } });
  expect(screen.getByLabelText(disabled)).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save game 3' }));
  expect(update).toHaveBeenCalledWith(2, expect.objectContaining({ server, [cleared]: null }));
});

it.each(['-1', '1.5', 'abc'])('rejects invalid metric %s with accessible inline validation', value => {
  const update = vi.fn();
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  const input = screen.getByLabelText('Net errors');
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).not.toHaveBeenCalled();
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(/non-negative whole number/i);
});

it('locks all controls and prevents duplicate submission while pending', async () => {
  let resolve!: () => void;
  const update = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  const form = screen.getByRole('form', { name: 'Draft game 1' });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(update).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Result')).toBeDisabled();
  expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  await act(async () => resolve());
  expect(screen.getByRole('button', { name: 'Save game 1' })).toBeEnabled();
});

it('shows a fixed safe error and allows retry when saving fails', async () => {
  const update = vi.fn().mockRejectedValue(new Error('SECRET provider details'));
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not save/i);
  expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save game 1' })).toBeEnabled();
});

it('reflects updated game props from the parent', () => {
  const update = vi.fn();
  const { rerender } = render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  rerender(<DraftGameCard game={{ ...game, result: 'lost', netErrors: 4 }} index={0} onUpdate={update} />);
  expect(screen.getByLabelText('Result')).toHaveDisplayValue('Lost');
  expect(screen.getByLabelText('Net errors')).toHaveValue('4');
});

it('clears an invalid service value before switching server and submitting', () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  fireEvent.change(screen.getByLabelText('Double faults'), { target: { value: '-2' } });
  fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'opponent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).toHaveBeenCalledWith(0, expect.objectContaining({ server: 'opponent', doubleFaults: null }));
});

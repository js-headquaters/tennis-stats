import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import DraftGameCard from './DraftGameCard';
import type { DraftGame } from '../../domain/model';

const style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style);
const game: DraftGame = { server: 'player', result: 'won', netErrors: 0, wideErrors: null, longErrors: 1, doubleFaults: 2, failedReturns: null, unforcedErrors: null, comments: null };
const plain: DraftGame = { server: 'player', result: 'lost', netErrors: null, wideErrors: null, longErrors: null, doubleFaults: null, failedReturns: null, unforcedErrors: 3, comments: 'Late on the backhand' };
const details = () => screen.getByText('Add details').closest('details')!;

it('labels each field and distinguishes unknown from zero when saving', () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  expect(screen.getByRole('form', { name: 'Draft game 1' })).toBeInTheDocument();
  expect(screen.getByLabelText('Result')).toHaveDisplayValue('Won');
  expect(screen.getByLabelText('Server')).toHaveDisplayValue('Player served');
  for (const label of ['Unforced errors', 'Double faults', 'Net errors', 'Wide errors', 'Long errors', 'Game comment']) expect(screen.getByLabelText(label)).toBeInTheDocument();
  expect(screen.queryByLabelText(/failed returns|receive errors/i)).not.toBeInTheDocument();
  expect(within(screen.getByTestId('draft-metric-netErrors')).getByText('0')).toBeInTheDocument();
  expect(within(screen.getByTestId('draft-metric-wideErrors')).getByLabelText(/unknown/i)).toHaveTextContent('—');
  expect(within(screen.getByTestId('draft-metric-unforcedErrors')).getByLabelText(/unknown/i)).toHaveTextContent('—');
  fireEvent.change(screen.getByLabelText('Net errors'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Wide errors'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).toHaveBeenCalledWith(0, { server: 'player', result: 'won', unforcedErrors: null, netErrors: null, wideErrors: 0, longErrors: 1, doubleFaults: 2, failedReturns: null, comments: null });
});

it('shows the high-level total, receive errors and comment first, with details collapsed when none are recorded', () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={{ ...plain, server: 'opponent', failedReturns: 1 }} index={1} onUpdate={update} />);
  expect(screen.getByLabelText('Unforced errors')).toHaveValue('3');
  expect(screen.getByLabelText('Receive errors')).toHaveValue('1');
  expect(screen.queryByLabelText('Double faults')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Game comment')).toHaveValue('Late on the backhand');
  expect(screen.getByLabelText('Game comment').tagName).toBe('TEXTAREA');
  expect(details()).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('Add details'));
  expect(details()).toHaveAttribute('open');
});

it('auto-opens details when the draft has any detail value', () => {
  render(<DraftGameCard game={{ ...plain, wideErrors: 0 }} index={0} onUpdate={vi.fn()} />);
  expect(details()).toHaveAttribute('open');
});

it('opens details when a later draft revision adds a detail value', () => {
  const { rerender } = render(<DraftGameCard game={plain} index={0} onUpdate={vi.fn()} />);
  expect(details()).not.toHaveAttribute('open');
  rerender(<DraftGameCard game={{ ...plain, longErrors: 2 }} index={0} onUpdate={vi.fn()} />);
  expect(details()).toHaveAttribute('open');
});

it('saves an edited total and trimmed comment, turning a blank comment into null', async () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={plain} index={0} onUpdate={update} />);
  fireEvent.change(screen.getByLabelText('Unforced errors'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Game comment'), { target: { value: '  Stayed calm  ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save game 1' })); });
  expect(update).toHaveBeenLastCalledWith(0, expect.objectContaining({ unforcedErrors: 0, comments: 'Stayed calm' }));
  fireEvent.change(screen.getByLabelText('Game comment'), { target: { value: '   ' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save game 1' })); });
  expect(update).toHaveBeenLastCalledWith(0, expect.objectContaining({ comments: null }));
});

it('rejects an over-long comment with accessible inline validation', () => {
  const update = vi.fn();
  render(<DraftGameCard game={plain} index={0} onUpdate={update} />);
  const comment = screen.getByLabelText('Game comment');
  fireEvent.change(comment, { target: { value: 'x'.repeat(10_001) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).not.toHaveBeenCalled();
  expect(comment).toHaveAttribute('aria-invalid', 'true');
  expect(comment).toHaveAccessibleDescription(/at most 10000 characters/i);
});

it.each([
  ['opponent', game, 'Double faults', 'Receive errors', 'doubleFaults'],
  ['player', { ...game, server: 'opponent', doubleFaults: null, failedReturns: 3 } as DraftGame, 'Receive errors', 'Double faults', 'failedReturns'],
] as const)('clears the incompatible metric when switching to %s', (server, initial, before, after, cleared) => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={initial} index={2} onUpdate={update} />);
  expect(screen.getByLabelText(before)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Server'), { target: { value: server } });
  expect(screen.queryByLabelText(before)).not.toBeInTheDocument();
  expect(screen.getByLabelText(after)).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Save game 3' }));
  expect(update).toHaveBeenCalledWith(2, expect.objectContaining({ server, [cleared]: null }));
});

it.each(['-1', '1.5', 'abc', '9007199254740992'])('rejects invalid metric %s with accessible inline validation', value => {
  const update = vi.fn();
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  for (const label of ['Net errors', 'Unforced errors']) {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
    expect(update).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/non-negative whole number/i);
  }
});

it('opens collapsed details to reveal an invalid detail value', () => {
  render(<DraftGameCard game={plain} index={0} onUpdate={vi.fn()} />);
  fireEvent.click(screen.getByText('Add details'));
  fireEvent.change(screen.getByLabelText('Net errors'), { target: { value: '-1' } });
  fireEvent.click(screen.getByText('Add details'));
  expect(details()).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(details()).toHaveAttribute('open');
});

it('gives every control and the details disclosure a 44px touch target', () => {
  render(<DraftGameCard game={game} index={0} onUpdate={vi.fn()} />);
  const elements = [screen.getByText('Add details'), ...['Result', 'Server', 'Unforced errors', 'Double faults', 'Net errors', 'Wide errors', 'Long errors', 'Game comment'].map(label => screen.getByLabelText(label)), ...screen.getAllByRole('button')];
  for (const element of elements) { const css = getComputedStyle(element); expect(parseFloat(css.minHeight)).toBeGreaterThanOrEqual(44); expect(parseFloat(css.minWidth)).toBeGreaterThanOrEqual(44); }
});

it('locks all controls and prevents duplicate submission while pending', async () => {
  let resolve!: () => void;
  const update = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  const form = screen.getByRole('form', { name: 'Draft game 1' });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(update).toHaveBeenCalledTimes(1);
  for (const label of ['Result', 'Unforced errors', 'Game comment']) expect(screen.getByLabelText(label)).toBeDisabled();
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
  rerender(<DraftGameCard game={{ ...game, result: 'lost', netErrors: 4, unforcedErrors: 5, comments: 'Revised' }} index={0} onUpdate={update} />);
  expect(screen.getByLabelText('Result')).toHaveDisplayValue('Lost');
  expect(screen.getByLabelText('Net errors')).toHaveValue('4');
  expect(screen.getByLabelText('Unforced errors')).toHaveValue('5');
  expect(screen.getByLabelText('Game comment')).toHaveValue('Revised');
});

it('discards edits back to the draft values', () => {
  const dirty = vi.fn();
  render(<DraftGameCard game={plain} index={0} onUpdate={vi.fn()} onDirtyChange={dirty} />);
  fireEvent.change(screen.getByLabelText('Game comment'), { target: { value: 'Changed' } });
  expect(dirty).toHaveBeenLastCalledWith(0, true);
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  expect(screen.getByLabelText('Game comment')).toHaveValue('Late on the backhand');
  expect(dirty).toHaveBeenLastCalledWith(0, false);
});

it('clears an invalid service value before switching server and submitting', () => {
  const update = vi.fn().mockResolvedValue(undefined);
  render(<DraftGameCard game={game} index={0} onUpdate={update} />);
  fireEvent.change(screen.getByLabelText('Double faults'), { target: { value: '-2' } });
  fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'opponent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save game 1' }));
  expect(update).toHaveBeenCalledWith(0, expect.objectContaining({ server: 'opponent', doubleFaults: null }));
});

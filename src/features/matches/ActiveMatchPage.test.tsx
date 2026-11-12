import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { MatchServiceDeps } from '../../application/matchService';
import type { TennisRepository } from '../../application/ports';
import type { MatchBundle } from '../../domain/model';
import ActiveMatchPage from './ActiveMatchPage';

const now = '2026-01-01T00:00:00.000Z';
function fixture(): MatchBundle { return { opponent: { id:'o', name:'Alex', normalizedName:'alex', createdAt:now, updatedAt:now }, match: { id:'m', opponentId:'o', playedAt:now, format:'oneSet', firstServer:'player', status:'active', comments:null, createdAt:now, updatedAt:now }, sets:[{ id:'s', matchId:'m', ordinal:1, kind:'standard', status:'active', tieBreakId:null, createdAt:now, updatedAt:now }], games:[], tieBreaks:[] }; }
function setup(initial?: MatchBundle) {
  let data: MatchBundle = initial ?? fixture();
  const save = vi.fn(async (bundle: MatchBundle) => { data = structuredClone(bundle); });
  const get = vi.fn(async () => structuredClone(data));
  const repository = { getMatchBundle:get, listMatches:async () => [data.match], saveMatchBundle:save, close:vi.fn() } as unknown as TennisRepository;
  let id = 0; const deps: MatchServiceDeps = { repository, clock:{ now:() => now }, ids:{ next:() => `g${++id}` } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  return { save, get, data: () => data };
}
it('shows context and adds a manual game with zero and unknown metrics', async () => {
  const { save, data } = setup();
  expect(await screen.findByText(/Alex/)).toBeInTheDocument();
  expect(screen.getByText(/next server: player/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name:/voice/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name:/manual/i }));
  fireEvent.change(screen.getByLabelText('Net errors'), { target:{ value:'0' } });
  fireEvent.click(screen.getByRole('button', { name:'Add game' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(data().games[0].netErrors).toBe(0); expect(data().games[0].wideErrors).toBeNull();
});
it('previews disruptive delete, cancels without save, and confirms explicitly', async () => {
  const { save } = setup();
  await screen.findByText(/Alex/);
  for (let i = 0; i < 2; i++) { fireEvent.click(screen.getByRole('button', { name:/manual/i })); fireEvent.click(screen.getByRole('button', { name:'Add game' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(i + 1)); }
  fireEvent.click(screen.getByRole('button', { name:'Delete game 1' }));
  expect(await screen.findByRole('region', { name:/affected records/i })).toHaveTextContent('g2');
  expect(save).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name:'Cancel correction' })); expect(save).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name:'Delete game 1' })); await screen.findByRole('region', { name:/affected records/i });
  fireEvent.click(screen.getByRole('button', { name:'Confirm affected records' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
});

it('saves comments and confirms finishing the match', async () => {
  const { save, data } = setup(); await screen.findByText(/Alex/);
  fireEvent.change(screen.getByLabelText('Comments'), { target:{ value:'Windy day' } });
  fireEvent.click(screen.getByRole('button', { name:'Save comments' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(data().match.comments).toBe('Windy day');
  fireEvent.click(screen.getByRole('button', { name:'Finish match' })); expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name:'Confirm finish match' }));
  await waitFor(() => expect(data().match.status).toBe('completed'));
});
it('shows the standard tie-break only at six games all', async () => {
  const b = fixture(); b.games = Array.from({length:12}, (_,i) => ({ id:`game${i}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' : 'player', result:i % 2 ? 'lost' : 'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }));
  const { save, data } = setup(b); expect(await screen.findByRole('form', { name:'Standard tie-break' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Player points'), { target:{ value:'7' } }); fireEvent.change(screen.getByLabelText('Opponent points'), { target:{ value:'5' } });
  fireEvent.click(screen.getByRole('button', { name:'Complete tie-break' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(data().tieBreaks[0].playerPoints).toBe(7);
});
it('shows a super tie-break prompt for a deciding set', async () => {
  const b = fixture(); b.sets[0].kind = 'decidingSuperTiebreak'; setup(b);
  expect(await screen.findByRole('form', { name:'Super tie-break' })).toBeInTheDocument();
});
it('edits a non-disruptive metric immediately', async () => {
  const b = fixture(); b.games = [{ id:'g1', setId:'s', ordinal:1, server:'player', result:'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }];
  const { save, data } = setup(b); await screen.findByText(/Alex/);
  fireEvent.click(screen.getByRole('button', { name:'Edit game 1' })); fireEvent.change(screen.getByLabelText('Net errors'), { target:{ value:'2' } });
  fireEvent.click(screen.getByRole('button', { name:'Save game' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(data().games[0].netErrors).toBe(2);
});
it('offers retry when loading fails', async () => {
  const b = fixture(); const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(b);
  const deps: MatchServiceDeps = { repository: { getMatchBundle:get, close:vi.fn() } as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('offline'); fireEvent.click(screen.getByRole('button', { name:'Retry' })); expect(await screen.findByText(/Alex/)).toBeInTheDocument(); expect(get).toHaveBeenCalledTimes(2);
});
it('rejects server-specific metrics before saving', async () => {
  const { save } = setup(); await screen.findByText(/Alex/);
  fireEvent.click(screen.getByRole('button', { name:/manual/i }));
  fireEvent.change(screen.getByLabelText('Failed returns'), { target:{ value:'0' } });
  fireEvent.click(screen.getByRole('button', { name:'Add game' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/failed returns apply to opponent service/i); expect(save).not.toHaveBeenCalled();
});
it('ends a set early only after confirmation', async () => {
  const { save, data } = setup(); await screen.findByText(/Alex/);
  fireEvent.click(screen.getByRole('button', { name:'End set early' })); expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name:'Confirm end set' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(data().sets[0].status).toBe('unfinished');
});
it('shows a not-found state with retry', async () => {
  const deps: MatchServiceDeps = { repository: { getMatchBundle:async () => undefined, close:vi.fn() } as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Match not found'); expect(screen.getByRole('button', { name:'Retry' })).toBeInTheDocument();
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type { MatchServiceDeps } from '../../application/matchService';
import type { RecoveryStatus, TennisRepository } from '../../application/ports';
import type { MatchBundle } from '../../domain/model';
import ActiveMatchPage from './ActiveMatchPage';
import { dependencies } from '../../app/dependencies';

const now = '2026-01-01T00:00:00.000Z';
function fixture(): MatchBundle { return { opponent: { id:'o', name:'Alex', normalizedName:'alex', createdAt:now, updatedAt:now }, match: { id:'m', opponentId:'o', playedAt:now, format:'oneSet', firstServer:'player', status:'active', comments:null, createdAt:now, updatedAt:now }, sets:[{ id:'s', matchId:'m', ordinal:1, kind:'standard', status:'active', tieBreakId:null, createdAt:now, updatedAt:now }], games:[], tieBreaks:[] }; }
const normal = () => ({ mode:'normal' as const });
const readOnly = () => ({ mode:'readOnly' as const, diagnostics:{ code:'newer-data-version' as const, message:'m', failedStep:null, storedDataVersion:3, appDataVersion:2, appVersion:null, errorName:'Error' } });
function setup(initial?: MatchBundle, getRecoveryStatus: () => RecoveryStatus = normal) {
  let data: MatchBundle = initial ?? fixture();
  const save = vi.fn(async (bundle: MatchBundle) => { data = structuredClone(bundle); });
  const get = vi.fn(async () => structuredClone(data));
  const repository = { getMatchBundle:get, listMatches:async () => [data.match], saveMatchBundle:save, close:vi.fn(), getRecoveryStatus } as unknown as TennisRepository;
  let id = 0; const deps: MatchServiceDeps = { repository, clock:{ now:() => now }, ids:{ next:() => `g${++id}` } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  return { save, get, data: () => data };
}
it('shows context and adds a manual game with zero and unknown metrics', async () => {
  const { save, data } = setup();
  expect(await screen.findByText(/Alex/)).toBeInTheDocument();
  expect(screen.getByText(/next server: player/i)).toBeInTheDocument();
  expect(screen.getByRole('link', { name:/voice/i })).toHaveAttribute('href', '/matches/m/record');
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
  const deps: MatchServiceDeps = { repository: { getMatchBundle:get, close:vi.fn(), getRecoveryStatus:normal } as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
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
  const deps: MatchServiceDeps = { repository: { getMatchBundle:async () => undefined, close:vi.fn(), getRecoveryStatus:normal } as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
  render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Match not found'); expect(screen.getByRole('button', { name:'Retry' })).toBeInTheDocument();
});

it('shows the correct next server after a standard tie-break', async () => {
  const b = fixture(); b.match.format = 'openPractice'; b.sets[0].status = 'completed'; b.sets[0].tieBreakId = 'tb';
  b.sets.push({ ...b.sets[0], id:'s2', ordinal:2, status:'active', tieBreakId:null });
  b.games = Array.from({length:12}, (_,i) => ({ id:`game${i}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' : 'player', result:i % 2 ? 'lost' : 'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }));
  b.tieBreaks = [{ id:'tb', setId:'s', kind:'standard', playerPoints:7, opponentPoints:5, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, createdAt:now, updatedAt:now }];
  setup(b); expect(await screen.findByText(/next server: opponent/i)).toBeInTheDocument();
});

it('hides the previous match while a new route loads', async () => {
  const first = fixture(); const second = fixture(); second.match.id = 'new'; second.opponent.name = 'Blair';
  let resolve!: (b: MatchBundle) => void; const deferred = new Promise<MatchBundle>(r => { resolve = r; });
  const save = vi.fn(); const get = vi.fn((id: string) => id === 'm' ? Promise.resolve(first) : deferred);
  const deps: MatchServiceDeps = { repository: { getMatchBundle:get, saveMatchBundle:save, close:vi.fn(), getRecoveryStatus:normal } as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
  const router = createMemoryRouter([{ path:'/matches/:matchId/live', element:<ActiveMatchPage deps={deps} /> }], { initialEntries:['/matches/m/live'] });
  render(<RouterProvider router={router} />); await screen.findByText(/Alex/);
  await act(async () => { await router.navigate('/matches/new/live'); });
  expect(screen.queryByText(/Alex/)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name:'Save comments' })).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  await act(async () => { resolve(second); }); expect(await screen.findByText(/Blair/)).toBeInTheDocument();
});
it('closes each owned repository once on failed load and retry, but not injected repositories', async () => {
  const failed = { getMatchBundle:vi.fn().mockRejectedValue(new Error('offline')), close:vi.fn() };
  const success = { getMatchBundle:vi.fn().mockResolvedValue(fixture()), close:vi.fn(), getRecoveryStatus:() => ({ mode:'normal' as const }) };
  const open = vi.spyOn(dependencies, 'openDatabase').mockResolvedValueOnce(failed as never).mockResolvedValueOnce(success as never);
  const view = render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('offline'); expect(failed.close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name:'Retry' })); await screen.findByText(/Alex/); expect(failed.close).toHaveBeenCalledTimes(1);
  view.unmount(); expect(success.close).toHaveBeenCalledTimes(1); expect(failed.close).toHaveBeenCalledTimes(1); open.mockRestore();
  const injected = { getMatchBundle:vi.fn().mockRejectedValue(new Error('offline')), close:vi.fn() };
  const deps: MatchServiceDeps = { repository:injected as unknown as TennisRepository, clock:{ now:() => now }, ids:{ next:() => 'id' } };
  const another = render(<MemoryRouter initialEntries={['/matches/m/live']}><Routes><Route path="/matches/:matchId/live" element={<ActiveMatchPage deps={deps} />} /></Routes></MemoryRouter>);
  await screen.findByRole('alert'); another.unmount(); expect(injected.close).not.toHaveBeenCalled();
});
it('lists downstream set, tie-break and game identifiers in correction confirmation', async () => {
  const b = fixture(); b.match.format = 'openPractice'; b.sets[0].status = 'completed';
  b.sets.push({ ...b.sets[0], id:'later-set', ordinal:2, tieBreakId:'later-tie' });
  b.games = [...Array.from({length:6}, (_,i) => ({ id:`first${i}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' as const : 'player' as const, result:'won' as const, score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now })), { id:'later-game', setId:'later-set', ordinal:1, server:'player', result:'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }];
  b.tieBreaks = [{ id:'later-tie', setId:'later-set', kind:'standard', playerPoints:7, opponentPoints:5, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, createdAt:now, updatedAt:now }];
  const { save } = setup(b); await screen.findByText(/Alex/); fireEvent.click(screen.getAllByRole('button', { name:'Delete game 1' })[1]);
  const region = await screen.findByRole('region', { name:/affected records/i });
  expect(region).toHaveTextContent('later-set'); expect(region).toHaveTextContent('later-tie'); expect(region).toHaveTextContent('later-game'); expect(save).not.toHaveBeenCalled();
});

it.each(['update', 'delete'] as const)('shows same-set tie-break and later games before %s confirmation', async operation => {
  const b = fixture(); b.match.format = 'openPractice'; b.sets[0].status = 'completed'; b.sets[0].tieBreakId = 'same-tie';
  b.sets.push({ ...b.sets[0], id:'next-set', ordinal:2, status:'active', tieBreakId:null });
  b.games = Array.from({length:12}, (_,i) => ({ id:`same-game-${i+1}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' : 'player', result:i % 2 ? 'lost' : 'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }));
  b.tieBreaks = [{ id:'same-tie', setId:'s', kind:'standard', playerPoints:7, opponentPoints:5, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, createdAt:now, updatedAt:now }];
  const { save, data } = setup(b); await screen.findByText(/Alex/);
  if (operation === 'update') { fireEvent.click(screen.getByRole('button', { name:'Edit game 2' })); fireEvent.change(screen.getByLabelText('Result'), { target:{ value:'won' } }); fireEvent.click(screen.getByRole('button', { name:'Save game' })); }
  else fireEvent.click(screen.getByRole('button', { name:'Delete game 2' }));
  const region = await screen.findByRole('region', { name:/affected records/i });
  expect(region).toHaveTextContent('same-tie');
  for (let i = 3; i <= 12; i++) expect(region).toHaveTextContent(`same-game-${i}`);
  expect(save).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name:'Confirm affected records' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1)); expect(data().tieBreaks).toEqual(b.tieBreaks);
  expect(data().games.filter(g => g.id !== 'same-game-2')).toEqual(b.games.filter(g => g.id !== 'same-game-2'));
});

it('identifies every game after early completion in correction confirmation', async () => {
  const b = fixture(); b.match.format = 'openPractice'; b.sets[0].status = 'completed';
  b.sets.push({ ...b.sets[0], id:'next-set', ordinal:2, status:'active' });
  const results = ['won','lost','won','lost','won','lost','won','lost','won','won'] as const;
  b.games = results.map((result,i) => ({ id:`chronology-${i+1}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' : 'player', result, score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }));
  const { save } = setup(b); await screen.findByText(/Alex/); fireEvent.click(screen.getByRole('button', { name:'Edit game 2' }));
  fireEvent.change(screen.getByLabelText('Result'), { target:{ value:'won' } }); fireEvent.click(screen.getByRole('button', { name:'Save game' }));
  const region = await screen.findByRole('region', { name:/affected records/i }); expect(region).toHaveTextContent('chronology-10'); expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name:'Confirm affected records' })); await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});
it('shows both post-completion games and server warnings after deleting an earlier game', async () => {
  const b = fixture(); b.match.format = 'openPractice'; b.sets[0].status = 'completed';
  b.sets.push({ ...b.sets[0], id:'next-set', ordinal:2, status:'active' });
  const results = ['won','won','won','lost','won','lost','won','lost','won','won','won'] as const;
  b.games = results.map((result,i) => ({ id:`post-${i+1}`, setId:'s', ordinal:i+1, server:i % 2 ? 'opponent' : 'player', result, score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }));
  const { save } = setup(b); await screen.findByText(/Alex/); fireEvent.click(screen.getByRole('button', { name:'Delete game 4' }));
  const region = await screen.findByRole('region', { name:/affected records/i }); expect(region).toHaveTextContent('post-10'); expect(region).toHaveTextContent('post-11'); expect(region).toHaveTextContent('expected server shifts'); expect(save).not.toHaveBeenCalled();
});
it('in read-only recovery mode explains that editing is off and disables every write action', async () => {
  const base = fixture();
  const withGame: MatchBundle = { ...base, games:[{ id:'g1', setId:'s', ordinal:1, server:'player', result:'won', score:null, netErrors:null, wideErrors:null, longErrors:null, doubleFaults:null, failedReturns:null, createdAt:now, updatedAt:now }] };
  const { save } = setup(withGame, readOnly);
  expect(await screen.findByText(/Alex/)).toBeInTheDocument();
  expect(screen.getByText(/read-only recovery mode/i)).toHaveTextContent(/adding or editing games, recording and finishing the match are turned off/i);
  expect(screen.getByRole('button', { name:/manual/i })).toBeDisabled();
  expect(screen.queryByRole('link', { name:/voice/i })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name:'Finish match' })).toBeDisabled();
  expect(screen.getByRole('button', { name:'End set early' })).toBeDisabled();
  expect(screen.getByRole('button', { name:'Save comments' })).toBeDisabled();
  expect(screen.getByRole('button', { name:'Delete game 1' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});

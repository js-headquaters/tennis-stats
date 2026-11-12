import type { Locator, Page } from '@playwright/test';
import { FIXED_NOW, buildMatchBundle, buildSnapshot, expect, mockAi, readDatabase, seedDatabase, sortById, test, type AiMock, type MatchSpec } from './fixtures';

// Journeys 3 (manual entry when AI is unavailable), 4 (serving order inference, edit server/result/statistic),
// 5 (auto-complete a set, end another early), 6 (standard and super tie-break summaries),
// 7 (finish, reopen, correct, recalculate). Assertions read the stored rows back, not only the DOM.

let ai: AiMock;
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  ai = await mockAi(page, { transcription: { type: 'network' }, parser: { type: 'network' } }); // AI is unavailable
});
test.afterEach(() => { expect(ai.calls, 'manual journeys never call an AI provider').toEqual([]); });

const resultFact = (page: Page) => page.locator('.match-facts > div').filter({ has: page.locator('dt', { hasText: /^Result$/ }) }).locator('dd');

async function seedLive(page: Page, spec: MatchSpec) {
  const bundle = buildMatchBundle(spec);
  await seedDatabase(page, buildSnapshot({ bundles: [bundle] }), { then: `#/matches/${spec.id}/live` });
  await expect(page.getByRole('heading', { name: `Match against ${bundle.opponent.name}` })).toBeVisible();
  return bundle;
}

/** Fills the manual/edit game form. Metric values: number → typed, '' → cleared (unknown), undefined → untouched. */
async function fillGame(form: Locator, values: { result?: 'Won' | 'Lost'; server?: 'Player served' | 'Opponent served'; metrics?: Partial<Record<'Net errors' | 'Wide errors' | 'Long errors' | 'Double faults' | 'Failed returns', number | ''>> }) {
  if (values.result) await form.getByLabel('Result').selectOption({ label: values.result });
  if (values.server) await form.getByLabel('Server').selectOption({ label: values.server });
  for (const [label, value] of Object.entries(values.metrics ?? {})) await form.getByLabel(label).fill(String(value));
}

async function addManualGame(page: Page, values: Parameters<typeof fillGame>[1]) {
  await page.getByRole('button', { name: 'Manual game entry' }).click();
  const form = page.getByRole('form', { name: 'Manual game entry' });
  await fillGame(form, values);
  await form.getByRole('button', { name: 'Add game' }).click();
  await expect(form).toBeHidden();
}

test('@smoke records games manually with inferred servers while AI is unavailable, keeping unknown apart from zero', async ({ page }) => {
  await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'oneSet', firstServer: 'opponent' });
  await expect(page.getByText('Next server: Opponent')).toBeVisible();

  await page.getByRole('button', { name: 'Manual game entry' }).click();
  const form = page.getByRole('form', { name: 'Manual game entry' });
  await expect(form.getByLabel('Server')).toHaveValue('opponent'); // inferred from the first server
  // Net errors left blank (unknown); wide errors typed as 0 (a recorded zero).
  await fillGame(form, { result: 'Lost', metrics: { 'Wide errors': 0, 'Failed returns': 2 } });
  await form.getByRole('button', { name: 'Add game' }).click();
  await expect(page.getByText('Next server: Player')).toBeVisible();

  await addManualGame(page, { result: 'Won', metrics: { 'Double faults': 0, 'Long errors': 1 } });
  await expect(page.getByText('Next server: Opponent')).toBeVisible();
  await expect(page.getByText('Set 1: 1–1 (active)')).toBeVisible();

  const game1 = page.getByRole('article', { name: 'Game 1', exact: true });
  await expect(game1.getByTestId('metric-netErrors').getByLabel('unknown')).toBeVisible();
  await expect(game1.getByTestId('metric-wideErrors')).toHaveText('Wide errors0');

  const stored = await readDatabase(page);
  expect(stored.games.sort((a, b) => a.ordinal - b.ordinal).map(({ ordinal, server, result, score, netErrors, wideErrors, longErrors, doubleFaults, failedReturns }) => ({ ordinal, server, result, score, netErrors, wideErrors, longErrors, doubleFaults, failedReturns }))).toEqual([
    { ordinal: 1, server: 'opponent', result: 'lost', score: null, netErrors: null, wideErrors: 0, longErrors: null, doubleFaults: null, failedReturns: 2 },
    { ordinal: 2, server: 'player', result: 'won', score: null, netErrors: null, wideErrors: null, longErrors: 1, doubleFaults: 0, failedReturns: null },
  ]);

  // The stored rows survive a reload and the inferred next server is recomputed from them.
  await page.reload();
  await expect(page.getByText('Next server: Opponent')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Game 2', exact: true })).toContainText('Player served');
});

test('rejects a metric that does not apply to the server without saving anything', async ({ page }) => {
  await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'oneSet', firstServer: 'player' });
  await page.getByRole('button', { name: 'Manual game entry' }).click();
  const form = page.getByRole('form', { name: 'Manual game entry' });
  await fillGame(form, { metrics: { 'Failed returns': 1 } });
  await form.getByRole('button', { name: 'Add game' }).click();
  await expect(form.getByRole('alert')).toHaveText('Double faults apply to player service; failed returns apply to opponent service.');
  expect((await readDatabase(page)).games).toEqual([]);
});

test('edits a server, result and statistic; a correction that shifts later servers is reviewed before it applies', async ({ page }) => {
  const bundle = await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'oneSet', firstServer: 'player', sets: [{ games: [{ result: 'won', netErrors: 1 }, 'L', 'W'] }] });
  await expect(page.getByText('Next server: Opponent')).toBeVisible();

  // Statistic + result edit on game 1: no conflicts, applied immediately; blank means unknown (null), not zero.
  await page.getByRole('button', { name: 'Edit game 1', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit game' });
  await expect(edit.getByLabel('Net errors')).toHaveValue('1');
  await fillGame(edit, { result: 'Lost', metrics: { 'Net errors': '', 'Wide errors': 0 } });
  await edit.getByRole('button', { name: 'Save game' }).click();
  await expect(edit).toBeHidden();
  let stored = await readDatabase(page);
  expect(stored.games.find(g => g.ordinal === 1)).toMatchObject({ result: 'lost', netErrors: null, wideErrors: 0, server: 'player' });
  await expect(page.getByText('Set 1: 1–2 (active)')).toBeVisible();

  // Server edit on game 2 shifts the expected server of game 3: conflicts are listed BEFORE anything is saved.
  const before = await readDatabase(page);
  await page.getByRole('button', { name: 'Edit game 2', exact: true }).click();
  await fillGame(edit, { server: 'Player served' });
  await edit.getByRole('button', { name: 'Save game' }).click();
  const review = page.getByRole('region', { name: 'Affected records' });
  await expect(review).toContainText('The expected server shifts for a later game');
  await expect(review).toContainText(`(game ${bundle.games[2].id})`);
  expect(await readDatabase(page), 'nothing is written while the conflict is under review').toEqual(before);

  await review.getByRole('button', { name: 'Confirm affected records' }).click();
  await expect(review).toBeHidden();
  stored = await readDatabase(page);
  const byOrdinal = (n: number) => stored.games.find(g => g.ordinal === n)!;
  expect(byOrdinal(2)).toMatchObject({ server: 'player', result: 'lost' });
  expect(byOrdinal(3), 'the later game is not silently rewritten').toEqual(before.games.find(g => g.ordinal === 3));
  expect(byOrdinal(1)).toEqual(before.games.find(g => g.ordinal === 1));
  await expect(page.getByRole('article', { name: 'Game 2', exact: true })).toContainText('Player served');
  // Inference continues from the last stored server (game 3 stays player → next is opponent).
  await expect(page.getByText('Next server: Opponent')).toBeVisible();
});

test('a set completes automatically and another set can be ended early', async ({ page }) => {
  await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'bestOfThree', firstServer: 'player', sets: [{ games: 'WWWWW' }] });
  await expect(page.getByText('Set 1: 5–0 (active)')).toBeVisible();

  await addManualGame(page, { result: 'Won' });
  await expect(page.getByText('Set 1: 6–0 (completed)')).toBeVisible();
  await expect(page.getByText('Set 2: 0–0 (active)')).toBeVisible();
  let stored = await readDatabase(page);
  expect(stored.sets.sort((a, b) => a.ordinal - b.ordinal).map(({ ordinal, status, kind }) => ({ ordinal, status, kind }))).toEqual([{ ordinal: 1, status: 'completed', kind: 'standard' }, { ordinal: 2, status: 'active', kind: 'standard' }]);
  expect(stored.matches[0].status).toBe('active');
  const set2 = stored.sets.find(set => set.ordinal === 2)!;

  await addManualGame(page, { result: 'Lost' });
  await expect(page.getByText('Set 2: 0–1 (active)')).toBeVisible();
  await page.getByRole('button', { name: 'End set early' }).click();
  const confirm = page.getByRole('region', { name: 'Confirm match action' });
  await expect(confirm).toContainText('End this set early?');
  await confirm.getByRole('button', { name: 'Confirm end set' }).click();
  await expect(page.getByText('Set 2: 0–1 (unfinished)')).toBeVisible();
  await expect(page.getByText('Set 3: 0–0 (active)')).toBeVisible();

  stored = await readDatabase(page);
  expect(stored.sets.find(set => set.id === set2.id)).toMatchObject({ status: 'unfinished' });
  expect(stored.sets.find(set => set.ordinal === 3)).toMatchObject({ status: 'active', kind: 'standard' });
  expect(stored.games.filter(game => game.setId === set2.id)).toHaveLength(1); // the early-ended set keeps its game
  expect(stored.matches[0].status).toBe('active');
});

test('standard and super tie-breaks are recorded with summaries, unknown metrics kept null', async ({ page }) => {
  // Set 1 won 6–3; set 2 at 6–6.
  await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'twoSetsSuperTiebreak', firstServer: 'player', sets: [{ games: 'WWLWLWLWW', status: 'completed' }, { games: 'WLWLWLWLWLWL' }] });
  await expect(page.getByText('Set 2: 6–6 (active)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manual game entry' })).toBeDisabled();

  const standard = page.getByRole('form', { name: 'Standard tie-break' });
  await standard.getByLabel('Player points').fill('5');
  await standard.getByLabel('Opponent points').fill('7');
  await standard.getByLabel('Double faults').fill('0');
  await standard.getByRole('button', { name: 'Complete tie-break' }).click();
  await expect(page.getByText('Set 2: 6–7 (completed)')).toBeVisible();
  await expect(page.getByText('Set 3: Super tie-break (active)')).toBeVisible();

  const superForm = page.getByRole('form', { name: 'Super tie-break' });
  await superForm.getByLabel('Player points').fill('10');
  await superForm.getByLabel('Opponent points').fill('8');
  await superForm.getByLabel('Net errors').fill('2');
  await superForm.getByRole('button', { name: 'Complete tie-break' }).click();
  await expect(page.getByText('Set 3: Super tie-break 10–8 (completed)')).toBeVisible();
  await expect(page.getByText(/Status: completed/)).toBeVisible();

  const stored = await readDatabase(page);
  expect(stored.matches[0].status).toBe('completed');
  const sets = stored.sets.sort((a, b) => a.ordinal - b.ordinal);
  expect(sets.map(set => [set.kind, set.status])).toEqual([['standard', 'completed'], ['standard', 'completed'], ['decidingSuperTiebreak', 'completed']]);
  const tie = (setId: string) => stored.tieBreaks.find(t => t.setId === setId)!;
  expect(tie(sets[1].id)).toMatchObject({ id: sets[1].tieBreakId, kind: 'standard', playerPoints: 5, opponentPoints: 7, doubleFaults: 0, netErrors: null, wideErrors: null, longErrors: null });
  expect(tie(sets[2].id)).toMatchObject({ id: sets[2].tieBreakId, kind: 'super', playerPoints: 10, opponentPoints: 8, netErrors: 2, doubleFaults: null });
  expect(stored.games.filter(g => g.setId === sets[2].id)).toEqual([]);

  await page.goto('#/matches/m1');
  await expect(resultFact(page)).toHaveText('Won, sets 2–1');
  const set2 = page.getByRole('region', { name: 'Set 2' });
  await expect(set2.getByRole('region', { name: 'Standard tie-break' })).toContainText('Points 5–7 · Lost');
  await expect(set2.getByRole('region', { name: 'Standard tie-break' }).getByTestId('metric-doubleFaults')).toHaveText('Double faults0');
  await expect(set2.getByRole('region', { name: 'Standard tie-break' }).getByTestId('metric-netErrors').getByLabel('unknown')).toBeVisible();
  await expect(set2).toContainText('Score 6–7 · Lost · Set completed');
  const set3 = page.getByRole('region', { name: 'Set 3' });
  await expect(set3.getByRole('heading', { name: 'Set 3: deciding super tie-break' })).toBeVisible();
  await expect(set3.getByRole('region', { name: 'Super tie-break' })).toContainText('Points 10–8 · Won');
  await expect(set3).toContainText('Score 10–8 · Won · Set completed');
});

test('finishes, reopens from history, reviews an early-game conflict, corrects and recalculates', async ({ page }) => {
  // Set 1 won 6–4 (completed), set 2 in progress 1–1.
  const bundle = await seedLive(page, { id: 'm1', opponent: 'Alex Example', format: 'bestOfThree', firstServer: 'player', sets: [{ games: 'WWLWLWLWLW', status: 'completed' }, { games: 'WL' }] });

  await page.getByRole('button', { name: 'Finish match' }).click();
  await page.getByRole('region', { name: 'Confirm match action' }).getByRole('button', { name: 'Confirm finish match' }).click();
  await expect(page.getByText(/Status: completed/)).toBeVisible();
  let stored = await readDatabase(page);
  expect(stored.matches[0].status).toBe('completed');
  expect(stored.sets.map(set => [set.ordinal, set.status]).sort()).toEqual([[1, 'completed'], [2, 'unfinished']]);

  // Reopen from history.
  await page.goto('#/matches');
  const row = page.getByRole('list', { name: 'Matches' }).getByRole('listitem').filter({ hasText: 'Alex Example' });
  await expect(row).toContainText('Completed');
  await expect(row).toContainText('No result, sets 1–0');
  await row.getByRole('link', { name: 'Alex Example' }).click();
  await expect(page).toHaveURL(/#\/matches\/m1$/);
  await expect(page.getByRole('region', { name: 'Set 1' })).toContainText('Score 6–4 · Won · Set completed');
  const averages = page.getByRole('table', { name: 'Match averages per metric' });
  await expect(averages.getByRole('row', { name: /Net errors/ })).toContainText('0 games');

  // Statistic correction without conflicts: applied and the averages recalculate.
  const set1 = page.getByRole('region', { name: 'Set 1' });
  await set1.getByRole('button', { name: 'Edit game 2', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Edit game' });
  await fillGame(edit, { metrics: { 'Net errors': 3 } });
  await edit.getByRole('button', { name: 'Save game' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Correction saved.' })).toBeVisible();
  await expect(averages.getByRole('row', { name: /Net errors/ })).toContainText('3');
  await expect(averages.getByRole('row', { name: /Net errors/ })).toContainText('1 game');
  stored = await readDatabase(page);
  expect(stored.games.find(g => g.id === bundle.games[1].id)!.netErrors).toBe(3);
  expect(sortById(stored.games.filter(g => g.id !== bundle.games[1].id)), 'other games untouched').toEqual(sortById(bundle.games.filter(g => g.id !== bundle.games[1].id)));

  // Early-game correction (game 1 won → lost) would undo set 1: conflicts are shown BEFORE applying.
  const beforeConflict = await readDatabase(page);
  await set1.getByRole('button', { name: 'Edit game 1', exact: true }).click();
  await fillGame(edit, { result: 'Lost' });
  await edit.getByRole('button', { name: 'Save game' }).click();
  const review = page.getByRole('region', { name: 'Affected records' });
  await expect(review).toContainText('Set 1 outcome changes');
  await expect(review).toContainText('Later set 2');
  await expect(review).toContainText(`Later game ${bundle.games[1].id} in set 1 is affected`);
  expect(await readDatabase(page), 'nothing is written before confirmation').toEqual(beforeConflict);

  // Cancelling keeps everything as stored.
  await review.getByRole('button', { name: 'Cancel correction' }).click();
  await expect(review).toBeHidden();
  expect(await readDatabase(page)).toEqual(beforeConflict);

  // Confirming applies only the corrected game and recalculates the derived result; status stays completed.
  await fillGame(edit, { result: 'Lost' });
  await edit.getByRole('button', { name: 'Save game' }).click();
  await review.getByRole('button', { name: 'Confirm affected records' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Correction saved.' })).toBeVisible();
  await expect(set1).toContainText('Score 5–5 · No result');
  await expect(resultFact(page)).toHaveText('No result, sets 0–0');

  stored = await readDatabase(page);
  expect(stored.matches[0].status).toBe('completed');
  expect(stored.games.find(g => g.id === bundle.games[0].id)).toMatchObject({ result: 'lost', server: 'player' });
  expect(sortById(stored.games.filter(g => g.id !== bundle.games[0].id)), 'later records are not silently rewritten').toEqual(sortById(beforeConflict.games.filter(g => g.id !== bundle.games[0].id)));
  expect(stored.sets.length, 'no sets are created or removed by the correction').toBe(beforeConflict.sets.length);
  expect(sortById(stored.sets).map(set => set.id), 'set rows keep their identity').toEqual(sortById(beforeConflict.sets).map(set => set.id));
  await expect(set1).toContainText('Recorded as completed — score no longer decides the set');

  // The recalculated result is what history shows after a reload.
  await page.goto('#/matches');
  await page.reload();
  await expect(page.getByRole('list', { name: 'Matches' }).getByRole('listitem').filter({ hasText: 'Alex Example' })).toContainText('No result, sets 0–0');
});

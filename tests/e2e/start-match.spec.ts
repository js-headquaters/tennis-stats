import type { Page } from '@playwright/test';
import type { MatchFormat } from '../../src/domain/model';
import { FIXED_NOW, buildMatchBundle, buildOpponent, buildSnapshot, expect, mockAi, openAppDatabase, readDatabase, seedDatabase, test } from './fixtures';

// Journeys 1 (create/reuse an opponent, start each format) and 13 (deployment-base routing under /tennis-stats/).

const FORMATS: Array<{ format: MatchFormat; option: string; liveLabel: string }> = [
  { format: 'twoSetsSuperTiebreak', option: 'Two sets plus deciding super tie-break', liveLabel: 'Two sets plus deciding super tie-break' },
  { format: 'openPractice', option: 'Open/practice match with manual completion', liveLabel: 'Open/practice match' },
  { format: 'oneSet', option: 'One set', liveLabel: 'One set' },
  { format: 'bestOfThree', option: 'Best of three sets', liveLabel: 'Best of three sets' },
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await mockAi(page); // no journey here may reach a provider; any attempt would be recorded and aborted
});

async function startMatch(page: Page, { opponent, option, firstServer }: { opponent: string; option: string; firstServer: 'Player serves first' | 'Opponent serves first' }) {
  await page.getByLabel('Opponent', { exact: true }).fill(opponent);
  await page.getByLabel('Format').selectOption({ label: option });
  await page.getByLabel(firstServer).check();
  await page.getByRole('button', { name: 'Start match' }).click();
  await expect(page).toHaveURL(/#\/matches\/[^/]+\/live$/);
  return decodeURIComponent(/#\/matches\/([^/]+)\/live$/.exec(page.url())![1]);
}

test('@smoke creates a new opponent and starts a match under /tennis-stats/', async ({ page }) => {
  await openAppDatabase(page, '#/matches/new');
  await expect(page.getByRole('heading', { name: 'New match' })).toBeVisible();
  // The date defaults to the (fixed) current local time; the context runs in UTC.
  await expect(page.getByLabel('Date and time')).toHaveValue('2026-03-14T10:00');
  const matchId = await startMatch(page, { opponent: '  Alex Example  ', option: 'Two sets plus deciding super tie-break', firstServer: 'Opponent serves first' });

  expect(new URL(page.url()).pathname).toBe('/tennis-stats/');
  await expect(page.getByRole('heading', { name: 'Match against Alex Example' })).toBeVisible();
  await expect(page.getByText('Next server: Opponent')).toBeVisible();
  await expect(page.getByText('Set 1: 0–0 (active)')).toBeVisible();

  const stored = await readDatabase(page);
  expect(stored.opponents).toEqual([expect.objectContaining({ name: 'Alex Example', normalizedName: 'alex example', createdAt: FIXED_NOW })]);
  expect(stored.matches).toEqual([expect.objectContaining({ id: matchId, opponentId: stored.opponents[0].id, format: 'twoSetsSuperTiebreak', firstServer: 'opponent', status: 'active', playedAt: FIXED_NOW, comments: null })]);
  expect(stored.sets).toEqual([expect.objectContaining({ matchId, ordinal: 1, kind: 'standard', status: 'active', tieBreakId: null })]);
  expect(stored.games).toEqual([]);
});

test('reuses an existing opponent and starts each match format', async ({ page }) => {
  const alex = buildOpponent('Alex Example', { createdAt: '2026-03-01T09:00:00.000Z', updatedAt: '2026-03-01T09:00:00.000Z' });
  const earlier = buildMatchBundle({ id: 'earlier', opponent: alex, status: 'completed', playedAt: '2026-03-01T09:00:00.000Z', format: 'oneSet', sets: [{ games: 'WWWWWW', status: 'completed' }] });
  await seedDatabase(page, buildSnapshot({ bundles: [earlier] }), { then: '#/matches/new' });

  const started: string[] = [];
  for (const [index, { format, option, liveLabel }] of FORMATS.entries()) {
    // The datalist suggests the stored opponent.
    await expect(page.locator('#opponent-suggestions option[value="Alex Example"]')).toHaveCount(1);
    const matchId = await startMatch(page, { opponent: index % 2 ? 'ALEX EXAMPLE' : ' alex example ', option, firstServer: index % 2 ? 'Opponent serves first' : 'Player serves first' });
    started.push(matchId);
    await expect(page.getByRole('heading', { name: 'Match against Alex Example' })).toBeVisible();
    await expect(page.getByText(`· ${liveLabel} · Status: active`)).toBeVisible();

    const stored = await readDatabase(page);
    expect(stored.opponents, 'the opponent is reused, not duplicated').toEqual([alex]);
    const match = stored.matches.find(item => item.id === matchId);
    expect(match).toMatchObject({ opponentId: alex.id, format, firstServer: index % 2 ? 'opponent' : 'player', status: 'active' });
    expect(stored.sets.filter(set => set.matchId === matchId)).toEqual([expect.objectContaining({ ordinal: 1, kind: 'standard', status: 'active' })]);

    // Only one active match may exist: the setup page offers resume/abandon instead of a second start.
    await page.goto('#/matches/new');
    await expect(page.getByText('An active match exists. Complete or abandon it before starting another.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Resume match to complete it' })).toHaveAttribute('href', `#/matches/${matchId}/live`);
    await page.getByRole('button', { name: 'Abandon active match' }).click();
    await expect(page.getByRole('button', { name: 'Start match' })).toBeVisible();
  }

  const stored = await readDatabase(page);
  expect(stored.matches.map(match => [match.id, match.format, match.status]).sort()).toEqual([
    ['earlier', 'oneSet', 'completed'],
    ...started.map((id, index) => [id, FORMATS[index].format, 'abandoned']),
  ].sort());
  expect(stored.games, 'the earlier match is untouched').toEqual(earlier.games);
});

test('direct navigation and reload work for every route under the /tennis-stats/ base', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === 'http://127.0.0.1:4174' && !url.pathname.startsWith('/tennis-stats/')) failures.push(`outside base: ${request.url()}`); });

  const done = buildMatchBundle({ id: 'done-1', opponent: 'Blake Sample', status: 'completed', format: 'oneSet', sets: [{ games: 'WWWWWW', status: 'completed' }] });
  const live = buildMatchBundle({ id: 'live-1', opponent: 'Casey Test', playedAt: '2026-03-13T18:00:00.000Z', sets: [{ games: 'WL' }] });
  await seedDatabase(page, buildSnapshot({ bundles: [done, live] }), { then: null });

  const routes: Array<[string, () => Promise<void>]> = [
    ['', () => expect(page.getByRole('region', { name: 'Active match' })).toContainText('Against Casey Test')],
    ['#/', () => expect(page.getByRole('link', { name: 'Resume match' })).toHaveAttribute('href', '#/matches/live-1/live')],
    ['#/matches', () => expect(page.getByRole('link', { name: 'Blake Sample' })).toBeVisible()],
    ['#/matches/new', () => expect(page.getByText('An active match exists. Complete or abandon it before starting another.')).toBeVisible()],
    ['#/matches/done-1', () => expect(page.getByRole('heading', { name: 'Match against Blake Sample' })).toBeVisible()],
    ['#/matches/live-1/live', () => expect(page.getByText('Set 1: 1–1 (active)')).toBeVisible()],
    ['#/settings', () => expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()],
  ];
  for (const [hash, assertVisible] of routes) {
    await page.goto('about:blank');
    await page.goto(`/tennis-stats/${hash}`);
    await assertVisible();
    await page.reload();
    await assertVisible();
    expect(new URL(page.url()).pathname).toBe('/tennis-stats/');
    expect(new URL(page.url()).hash).toBe(hash);
  }

  // In-app navigation stays on the hash router under the base.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Matches' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4174/tennis-stats/#/matches');
  await page.getByRole('link', { name: 'Blake Sample' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4174/tennis-stats/#/matches/done-1');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Match against Blake Sample' })).toBeVisible();
  expect(failures).toEqual([]);
});

import type { Locator, Page } from '@playwright/test';
import { FIXED_NOW, buildMatchBundle, buildSnapshot, expect, mockAi, readDatabase, seedDatabase, test, type AiMock, type GameSpec } from './fixtures';

// Journey 8 (weekly/monthly unforced, double-fault and receive-error averages, unknown vs explicit zero, sample sizes, trend against the
// previous calendar period, no raw totals) and journey 9 (history newest first, filtered by opponent and date range,
// completion labels), plus a post-match correction that recalculates the averages while the match stays completed.
// FIXED_NOW is Saturday 14 March 2026 (UTC browser): the current week is Mon 9 – Sun 15 March, the previous 2–8 March.

let ai: AiMock;
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  ai = await mockAi(page);
});
test.afterEach(() => { expect(ai.calls, 'statistics never call an AI provider').toEqual([]); });

const p = (result: 'won' | 'lost', metrics: Omit<Exclude<GameSpec, string>, 'result' | 'server'> = {}): GameSpec => ({ result, server: 'player', ...metrics });
const o = (result: 'won' | 'lost', metrics: Omit<Exclude<GameSpec, string>, 'result' | 'server'> = {}): GameSpec => ({ result, server: 'opponent', ...metrics });

/** Matches around the week/month boundaries. Metric values are chosen so that averaging null as 0, or dropping explicit
 * zeros, or counting tie-breaks, each gives a different visible number. */
function statisticsSnapshot() {
  return buildSnapshot({ bundles: [
    // Current week, first instant (Monday 00:00). The tie-break's 9s must never count.
    buildMatchBundle({ id: 'a', opponent: 'Alex Example', status: 'completed', format: 'oneSet', playedAt: '2026-03-09T00:00:00.000Z', sets: [{ status: 'completed', games: [
      p('won', { netErrors: 4, longErrors: 1, doubleFaults: 1 }), o('lost', { netErrors: 0, longErrors: 1, failedReturns: 2 }), p('won', { netErrors: 2, longErrors: 1 }),
    ], tieBreak: { playerPoints: 7, opponentPoints: 5, netErrors: 9, doubleFaults: 9 } }] }),
    // Current week, last instant (Sunday 23:59:59.999).
    buildMatchBundle({ id: 'b', opponent: 'Blake Sample', status: 'completed', format: 'oneSet', playedAt: '2026-03-15T23:59:59.999Z', sets: [{ games: [
      p('won', { netErrors: 3, longErrors: 0, doubleFaults: 0 }), o('lost', { longErrors: 0, failedReturns: 1 }),
    ] }] }),
    // Previous week, last instant.
    buildMatchBundle({ id: 'c', opponent: 'Alex Example', status: 'completed', format: 'oneSet', playedAt: '2026-03-08T23:59:59.999Z', sets: [{ games: [
      p('lost', { netErrors: 3, wideErrors: 1, doubleFaults: 0 }), o('won', { netErrors: 3, failedReturns: 2 }),
    ] }] }),
    // Two weeks ago, but still March.
    buildMatchBundle({ id: 'e', opponent: 'Casey Test', status: 'completed', format: 'oneSet', playedAt: '2026-03-01T12:00:00.000Z', sets: [{ games: [p('won', { netErrors: 5 })] }] }),
    // February, last instant: the previous month.
    buildMatchBundle({ id: 'd', opponent: 'Casey Test', status: 'completed', format: 'oneSet', playedAt: '2026-02-28T23:59:59.999Z', sets: [{ games: [
      p('won', { netErrors: 4, longErrors: 2 }), o('lost', { netErrors: 0, failedReturns: 0 }),
    ] }] }),
  ] });
}

const card = (page: Page, label: string) => page.getByRole('article', { name: label, exact: true });
async function expectCard(page: Page, label: string, { average, sample, trend }: { average: string | null; sample: string; trend: string }) {
  const metric = card(page, label);
  const value = metric.locator('.metric-card-average');
  if (average === null) await expect(value.getByRole('img', { name: 'unknown' }), `${label}: unknown, not zero`).toBeVisible();
  else await expect(value, `${label} average`).toHaveText(average);
  await expect(metric.locator('.metric-card-stats > div').filter({ has: page.locator('dt', { hasText: /^Sample$/ }) }).locator('dd'), `${label} sample`).toHaveText(sample);
  await expect(metric.locator('.metric-card-trend dd'), `${label} trend`).toHaveText(trend);
}
const periodHeading = (page: Page) => page.locator('.period-nav h3');

test('@smoke weekly averages use known values only, show sample sizes and the trend against the previous week', async ({ page }) => {
  await seedDatabase(page, statisticsSnapshot(), { then: '#/' });
  await expect(periodHeading(page)).toHaveText('9–15 Mar 2026');
  await expect(page.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Unforced errors sum net + wide + long per game; partial metrics count and explicit zeros remain real samples.
  await expectCard(page, 'Unforced errors', { average: '2.4', sample: '5 games', trend: '↓ 1.1 lower than the previous week (3.5 across 2 games)' });
  // Double faults: service games only, tie-break excluded; last week's explicit 0 is a real comparison baseline.
  await expectCard(page, 'Double faults', { average: '0.5', sample: '2 service games', trend: '↑ 0.5 higher than the previous week (0 across 1 service game)' });
  // Receive errors use the existing failed-return values per RETURN game.
  await expectCard(page, 'Receive errors', { average: '1.5', sample: '2 return games', trend: '↓ 0.5 lower than the previous week (2 across 1 return game)' });
  await expect(card(page, 'Receive errors')).toContainText('per return game');
  await expect(page.getByRole('region', { name: 'Statistics' }).getByRole('article')).toHaveCount(3);

  // No raw totals anywhere (this week's unforced-error total is 12).
  const statistics = page.getByRole('region', { name: 'Statistics' });
  await expect(statistics).not.toContainText(/total/i);
  await expect(card(page, 'Unforced errors').locator('.metric-card-stats')).not.toContainText('12');
});

test('monthly averages, earlier periods and calendar boundaries', async ({ page }) => {
  await seedDatabase(page, statisticsSnapshot(), { then: '#/' });

  // The previous week (2–8 Mar) holds only match c; it is compared with 23 Feb – 1 Mar, a week spanning two months
  // (matches d on 28 Feb and e on 1 Mar).
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(periodHeading(page)).toHaveText('2–8 Mar 2026');
  await expect(page.getByRole('button', { name: 'Next week' })).toBeEnabled();
  await expectCard(page, 'Unforced errors', { average: '3.5', sample: '2 games', trend: '↓ 0.17 lower than the previous week (3.67 across 3 games)' });
  await expectCard(page, 'Receive errors', { average: '2', sample: '1 return game', trend: '↑ 2 higher than the previous week (0 across 1 return game)' });
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(periodHeading(page)).toHaveText('23 Feb – 1 Mar 2026');
  await expectCard(page, 'Unforced errors', { average: '3.67', sample: '3 games', trend: 'No comparison: no recorded games in the previous week' });
  await page.getByRole('button', { name: 'Next week' }).click();
  await expectCard(page, 'Unforced errors', { average: '3.5', sample: '2 games', trend: '↓ 0.17 lower than the previous week (3.67 across 3 games)' });
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(periodHeading(page)).toHaveText('9–15 Mar 2026');
  await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();

  // March: matches a, b, c and e (1 March and 8 March belong to March even though they are earlier weeks); February: d.
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(periodHeading(page)).toHaveText('March 2026');
  await expectCard(page, 'Unforced errors', { average: '3', sample: '8 games', trend: '= Same as the previous month (3 across 2 games)' });
  await expectCard(page, 'Double faults', { average: '0.33', sample: '3 service games', trend: 'No comparison: no recorded service games in the previous month' });
  // February's single receive-error value is an explicit 0: it is a baseline, not "no data".
  await expectCard(page, 'Receive errors', { average: '1.67', sample: '3 return games', trend: '↑ 1.67 higher than the previous month (0 across 1 return game)' });

  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(periodHeading(page)).toHaveText('February 2026');
  await expectCard(page, 'Unforced errors', { average: '3', sample: '2 games', trend: 'No comparison: no recorded games in the previous month' });
  await expectCard(page, 'Receive errors', { average: '0', sample: '1 return game', trend: 'No comparison: no recorded return games in the previous month' });
  await expectCard(page, 'Double faults', { average: null, sample: '0 service games', trend: 'No comparison: no recorded service games in the selected or previous month' });
});

test('unknown is not averaged as zero, an explicit zero is; a post-match edit recalculates and the match stays completed', async ({ page }) => {
  const bundle = buildMatchBundle({ id: 'z', opponent: 'Alex Example', status: 'completed', format: 'oneSet', playedAt: '2026-03-12T10:00:00.000Z', sets: [{ status: 'unfinished', games: [
    p('won', { netErrors: null, wideErrors: 0 }), o('lost', { netErrors: 2, wideErrors: null, failedReturns: null }),
  ] }] });
  await seedDatabase(page, buildSnapshot({ bundles: [bundle] }), { then: '#/' });

  await expectCard(page, 'Unforced errors', { average: '1', sample: '2 games', trend: 'No comparison: no recorded games in the previous week' });
  await expectCard(page, 'Receive errors', { average: null, sample: '0 return games', trend: 'No comparison: no recorded return games in the selected or previous week' });
  await expectCard(page, 'Double faults', { average: null, sample: '0 service games', trend: 'No comparison: no recorded service games in the selected or previous week' });

  // The match details agree.
  await page.getByRole('link', { name: 'Alex Example' }).click();
  await expect(page).toHaveURL(/#\/matches\/z$/);
  const averages = page.getByRole('table', { name: 'Match averages per metric' });
  const row = (name: RegExp) => averages.getByRole('row', { name });
  // Derived from details: game 1 (wide 0) = 0 and game 2 (net 2) = 2 → average 1 over 2 games.
  await expect(row(/Unforced errors/)).toContainText('1');
  await expect(row(/Unforced errors/)).toContainText('2 games');
  await expect(row(/Receive errors/).getByRole('img', { name: 'unknown' })).toBeVisible();

  // Correct after completion: game 1 net errors unknown → 0, game 2 → 4; failed returns recorded as 0.
  const set1 = page.getByRole('region', { name: 'Set 1' });
  const edit = page.getByRole('form', { name: 'Edit game' });
  await set1.getByRole('button', { name: 'Edit game 1', exact: true }).click();
  if (!(await edit.locator('details').evaluate(el => (el as HTMLDetailsElement).open))) await edit.getByText('Add details').click();
  await edit.getByLabel('Net errors').fill('0');
  await edit.getByRole('button', { name: 'Save game' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Correction saved.' })).toBeVisible();
  await set1.getByRole('button', { name: 'Edit game 2', exact: true }).click();
  if (!(await edit.locator('details').evaluate(el => (el as HTMLDetailsElement).open))) await edit.getByText('Add details').click();
  await edit.getByLabel('Net errors').fill('4');
  await edit.getByLabel('Receive errors').fill('0');
  await edit.getByRole('button', { name: 'Save game' }).click();
  await expect(edit).toBeHidden();
  await expect(row(/Unforced errors/)).toContainText('2 games');
  await expect(row(/Receive errors/).getByRole('cell').first()).toHaveText('0');

  const stored = await readDatabase(page);
  expect(stored.matches).toMatchObject([{ id: 'z', status: 'completed' }]);
  expect([...stored.games].sort((x, y) => x.ordinal - y.ordinal).map(game => [game.netErrors, game.wideErrors, game.failedReturns])).toEqual([[0, 0, null], [4, null, 0]]);

  // The dashboard recalculates: (0+4)/2 now that the zero is recorded.
  await page.goto('#/');
  await expectCard(page, 'Unforced errors', { average: '2', sample: '2 games', trend: 'No comparison: no recorded games in the previous week' });
  await expectCard(page, 'Receive errors', { average: '0', sample: '1 return game', trend: 'No comparison: no recorded return games in the previous week' });
  await page.goto('#/matches');
  await expect(page.getByRole('list', { name: 'Matches' }).getByRole('listitem').filter({ hasText: 'Alex Example' })).toContainText('Completed');
});

test('an explicit unforced total wins over differing details; a legacy details-only game falls back to the detail sum', async ({ page }) => {
  const bundle = buildMatchBundle({ id: 'x', opponent: 'Alex Example', status: 'completed', format: 'oneSet', playedAt: '2026-03-12T10:00:00.000Z', sets: [{ status: 'unfinished', games: [
    p('won', { unforcedErrors: 7, netErrors: 1, wideErrors: 1, longErrors: 1 }), // explicit 7, details would give 3
    o('lost', { netErrors: 2, wideErrors: 1, longErrors: 1 }), // legacy: details only → 4
  ] }] });
  await seedDatabase(page, buildSnapshot({ bundles: [bundle] }), { then: '#/' });
  // (7 + 4) / 2 = 5.5; using only details would give 3.5, using only explicit totals 7.
  await expectCard(page, 'Unforced errors', { average: '5.5', sample: '2 games', trend: 'No comparison: no recorded games in the previous week' });

  await page.getByRole('link', { name: 'Alex Example' }).click();
  await expect(page).toHaveURL(/#\/matches\/x$/);
  const averages = page.getByRole('table', { name: 'Match averages per metric' });
  await expect(averages.getByRole('row', { name: /Unforced errors/ })).toContainText('5.5');
  await expect(averages.getByRole('row', { name: /Unforced errors/ })).toContainText('2 games');
  await expect(page.getByRole('article', { name: 'Game 1', exact: true }).getByTestId('metric-unforcedErrors')).toContainText('7');
  const legacy = page.getByRole('article', { name: 'Game 2', exact: true }).getByTestId('metric-unforcedErrors');
  await expect(legacy).toContainText('4');
  await expect(legacy).toContainText('Derived from details');
});

test.describe('match history', () => {
  function historySnapshot() {
    return buildSnapshot({ bundles: [
      buildMatchBundle({ id: 'h1', opponent: 'Alex Example', status: 'completed', format: 'oneSet', playedAt: '2026-03-12T18:00:00.000Z', sets: [{ status: 'completed', games: 'WWWWWW' }] }),
      buildMatchBundle({ id: 'h2', opponent: 'Blake Sample', status: 'abandoned', format: 'twoSetsSuperTiebreak', playedAt: '2026-03-10T09:00:00.000Z', sets: [{ games: 'WL' }] }),
      buildMatchBundle({ id: 'h3', opponent: 'Alex Example', status: 'completed', format: 'bestOfThree', playedAt: '2026-02-27T23:30:00.000Z', sets: [{ status: 'completed', games: 'LLLLLL' }, { status: 'completed', games: 'LLLLLL' }] }),
      buildMatchBundle({ id: 'h4', opponent: 'Casey Test', status: 'active', format: 'openPractice', playedAt: '2026-03-14T08:00:00.000Z', sets: [{ games: 'WL' }] }),
      buildMatchBundle({ id: 'h5', opponent: 'Alex Example', status: 'completed', format: 'openPractice', playedAt: '2026-01-05T10:00:00.000Z', sets: [{ status: 'unfinished', games: 'WLW' }] }),
    ] });
  }
  const rows = (page: Page) => page.getByRole('list', { name: 'Matches' }).getByRole('listitem');
  async function expectRows(list: Locator, expected: string[][]) {
    await expect(list).toHaveCount(expected.length);
    for (const [index, parts] of expected.entries()) for (const part of parts) await expect(list.nth(index)).toContainText(part);
  }

  test('lists matches newest first with completion labels, and filters by opponent and date range', async ({ page }) => {
    await seedDatabase(page, historySnapshot(), { then: '#/matches' });
    await expectRows(rows(page), [
      ['Casey Test', '14 Mar 2026', 'In progress (unfinished)', 'Open/practice match'],
      ['Alex Example', '12 Mar 2026', 'Completed', 'One set', 'Won, sets 1–0', '6–0'],
      ['Blake Sample', '10 Mar 2026', 'Abandoned (unfinished)', 'Two sets plus deciding super tie-break'],
      ['Alex Example', '27 Feb 2026', 'Completed', 'Best of three sets', 'Lost, sets 0–2', '0–6, 0–6'],
      ['Alex Example', '5 Jan 2026', 'Completed', 'Open/practice match'],
    ]);

    // Opponent filter (the reusable opponent record), still newest first.
    await page.getByLabel('Opponent').selectOption({ label: 'Alex Example' });
    await expectRows(rows(page), [['Alex Example', '12 Mar 2026'], ['Alex Example', '27 Feb 2026'], ['Alex Example', '5 Jan 2026']]);

    // Plus an inclusive date range: both boundary days count (27 Feb 23:30 and 12 Mar 18:00).
    await page.getByLabel('From date').fill('2026-02-27');
    await page.getByLabel('To date').fill('2026-03-12');
    await expectRows(rows(page), [['Alex Example', '12 Mar 2026'], ['Alex Example', '27 Feb 2026']]);

    // Date range only.
    await page.getByLabel('Opponent').selectOption({ label: 'All opponents' });
    await expectRows(rows(page), [['Alex Example', '12 Mar 2026'], ['Blake Sample', '10 Mar 2026'], ['Alex Example', '27 Feb 2026']]);
    await page.getByLabel('To date').fill('2026-03-11');
    await expectRows(rows(page), [['Blake Sample', '10 Mar 2026'], ['Alex Example', '27 Feb 2026']]);

    // A range with no matches says so; clearing restores everything.
    await page.getByLabel('From date').fill('2026-03-13');
    await page.getByLabel('To date').fill('2026-03-13');
    await expect(page.getByText('No matches match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows(page)).toHaveCount(5);

    // A row opens its match.
    await rows(page).nth(3).getByRole('link', { name: 'Alex Example' }).click();
    await expect(page).toHaveURL(/#\/matches\/h3$/);
  });
});

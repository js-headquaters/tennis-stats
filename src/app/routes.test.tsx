import { render, screen } from '@testing-library/react';
import { createHashRouter, createMemoryRouter, Link, RouterProvider, useParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { draftPath, matchLivePath, matchPath, matchRecordPath } from './routes';
import { routes } from './router';

const hostile = 'a/b#c?d%e f';

it('encodes ids into single path segments', () => {
  expect(matchPath(hostile)).toBe('/matches/a%2Fb%23c%3Fd%25e%20f');
  expect(matchLivePath(hostile)).toBe('/matches/a%2Fb%23c%3Fd%25e%20f/live');
  expect(matchRecordPath(hostile)).toBe('/matches/a%2Fb%23c%3Fd%25e%20f/record');
  expect(draftPath(hostile)).toBe('/voice/a%2Fb%23c%3Fd%25e%20f');
});

function Probe() { const { matchId } = useParams(); return <p data-testid="id">{matchId}</p>; }
const probeRoutes = [{ path: '/', element: <Link to={matchPath(hostile)}>open</Link> }, { path: '/matches/:matchId', element: <Probe /> }, { path: '/matches/:matchId/live', element: <Probe /> }];

it('round-trips a hostile id through a memory-router link to the route param', async () => {
  const router = createMemoryRouter(probeRoutes, { initialEntries: ['/'] });
  render(<RouterProvider router={router} />);
  screen.getByRole('link', { name: 'open' }).click();
  expect(await screen.findByTestId('id')).toHaveTextContent(hostile);
});

it('round-trips a hostile id through a hash router, including a reload of the URL', async () => {
  window.location.hash = '#' + matchLivePath(hostile);
  render(<RouterProvider router={createHashRouter(probeRoutes)} />);
  expect(await screen.findByTestId('id')).toHaveTextContent(hostile);
  window.location.hash = '';
});

afterEach(() => { vi.restoreAllMocks(); });

function showAt(path: string) { render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />); }
function expectRecoveryLinks() {
  for (const name of ['Home', 'Matches', 'Settings']) expect(screen.getAllByRole('link', { name }).length).toBeGreaterThan(0);
}

it('shows a not-found page with navigation for an unknown route', async () => {
  showAt('/nope');
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  expectRecoveryLinks();
  expect(screen.getByRole('navigation', { name: /main/i })).toBeInTheDocument();
});

function Thrower(): never { throw new Error('SECRET_TOKEN_123'); }
type R = (typeof routes)[number];
function replaceSettings(list: R[]): R[] {
  return list.map(r => ({ ...r, path: r.path, element: r.path === '/settings' ? <Thrower /> : r.element, children: r.children ? replaceSettings(r.children) : undefined }) as R);
}

it('shows a fixed error page without leaking the error message when a page throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<RouterProvider router={createMemoryRouter(replaceSettings(routes), { initialEntries: ['/settings'] })} />);
  expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('SECRET_TOKEN_123');
  expectRecoveryLinks();
  expect(screen.getByRole('navigation', { name: /main/i })).toBeInTheDocument();
});

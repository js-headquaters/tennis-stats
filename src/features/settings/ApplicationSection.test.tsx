import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationSection, type ApplicationSources } from './ApplicationSection';
import SettingsPage from './SettingsPage';
import { createLocalSettings } from '../../infrastructure/settings/localSettings';
import type { ConnectivitySource } from '../../app/pwa';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function fakeConnectivity(initial: boolean) {
  let online = initial; const listeners = new Set<() => void>();
  const source: ConnectivitySource = { isOnline: () => online, subscribe: l => { listeners.add(l); return () => { listeners.delete(l); }; } };
  return { source, set(value: boolean) { online = value; listeners.forEach(l => l()); } };
}
const base = (over: Partial<ApplicationSources> = {}): ApplicationSources => ({
  connectivity: fakeConnectivity(true).source, isStandalone: () => false, serviceWorkerStatus: async () => 'ready',
  appVersion: '1.2.3', dataVersion: 2, loadStoredVersion: async () => 2, ...over,
});
const row = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

it('renders each row from the injected sources', async () => {
  render(<ApplicationSection {...base()} />);
  expect(screen.getByRole('heading', { name: 'Application' })).toBeInTheDocument();
  expect(row('App version')).toHaveTextContent('1.2.3');
  await waitFor(() => expect(row('Data (schema) version')).toHaveTextContent('App expects 2, stored 2'));
  expect(row('Network status')).toHaveTextContent('Online');
  expect(row('Installed')).toHaveTextContent(/No.*Share → Add to Home Screen/);
  await waitFor(() => expect(row('Offline readiness')).toHaveTextContent(/Ready/));
});

it('updates live when connectivity changes', () => {
  const c = fakeConnectivity(true);
  render(<ApplicationSection {...base({ connectivity: c.source })} />);
  expect(row('Network status')).toHaveAttribute('aria-live', 'polite');
  act(() => c.set(false));
  expect(row('Network status')).toHaveTextContent('Offline');
});

it('distinguishes standalone from browser', () => {
  render(<ApplicationSection {...base({ isStandalone: () => true })} />);
  expect(row('Installed')).toHaveTextContent(/^Yes/);
  expect(row('Installed')).not.toHaveTextContent('Add to Home Screen');
});

it('shows a stored/expected version mismatch and unavailable stored version', async () => {
  const { unmount } = render(<ApplicationSection {...base({ loadStoredVersion: async () => 1 })} />);
  await waitFor(() => expect(row('Data (schema) version')).toHaveTextContent('App expects 2, stored 1 (differs'));
  unmount();
  render(<ApplicationSection {...base({ loadStoredVersion: async () => { throw new Error('boom'); } })} />);
  await waitFor(() => expect(row('Data (schema) version')).toHaveTextContent('stored unavailable'));
});

it('reports service-worker states in text', async () => {
  for (const [status, text] of [['registering', /Registering/], ['not-supported', /Not supported/], ['unavailable', /Unavailable/]] as const) {
    const { unmount } = render(<ApplicationSection {...base({ serviceWorkerStatus: async () => status })} />);
    await waitFor(() => expect(row('Offline readiness')).toHaveTextContent(text));
    unmount();
  }
  render(<ApplicationSection {...base({ serviceWorkerStatus: async () => { throw new Error('x'); } })} />);
  await waitFor(() => expect(row('Offline readiness')).toHaveTextContent(/Unavailable/));
});

it('stays visible and unchanged while a settings data action holds the busy lock, and a failing read does not break the page', async () => {
  const store = createLocalSettings(localStorage);
  store.saveTranscription({ provider: 'openai', model: 'test', endpoint: '', apiKey: 'SENTINEL_FAKE_KEY' });
  let release!: () => void;
  const transfer = { download: () => { throw new Error('unused'); }, pick: vi.fn(() => new Promise<never>(() => {})) };
  const repository = { getRecoveryStatus: () => ({ mode: 'normal' as const }), close() {}, snapshot: () => new Promise(r => { release = () => r({ dataVersion: 2, opponents: [], matches: [], sets: [], games: [], tieBreaks: [], voiceDrafts: [] }); }) };
  const { container } = render(<SettingsPage store={store} data={{ repository: repository as never, transfer: transfer as never }} application={base()} />);
  expect(screen.getByRole('heading', { name: 'Application' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Data' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Transcription' })).toBeInTheDocument();
  const section = within(screen.getByRole('region', { name: 'Application' }));
  expect(section.queryByRole('group')).toBeNull();
  expect(container.querySelector('.application-settings')?.closest('fieldset')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
  await screen.findByText(/Other settings actions are paused/);
  expect(screen.getByRole('group', { name: 'Transcription' })).toBeDisabled();
  expect(section.getByRole('heading', { name: 'Application' })).toBeInTheDocument();
  expect(row('Network status')).toHaveTextContent('Online');
  expect(container.textContent).not.toContain('SENTINEL_FAKE_KEY');
  await act(async () => { release?.(); });
});

it('does not leak secrets or write anything', async () => {
  const store = createLocalSettings(localStorage);
  store.saveParser({ provider: 'openai', model: 'm', endpoint: 'https://e.example', apiKey: 'SENTINEL_FAKE_KEY' });
  const before = JSON.stringify({ ...localStorage });
  const { container } = render(<ApplicationSection {...base()} />);
  await screen.findByText(/App expects 2, stored 2/);
  expect(container.textContent).not.toContain('SENTINEL_FAKE_KEY');
  expect(JSON.stringify({ ...localStorage })).toBe(before);
});

it('default stored-version loader reads from a borrowed repository without writing or closing it', async () => {
  const close = vi.fn(); const snapshot = vi.fn(async () => ({ dataVersion: 1 }));
  const repository = { getRecoveryStatus: () => ({ mode: 'normal' }), snapshot, close };
  render(<ApplicationSection {...base({ loadStoredVersion: undefined, repository: repository as never })} />);
  await waitFor(() => expect(row('Data (schema) version')).toHaveTextContent('stored 1'));
  expect(close).not.toHaveBeenCalled();
});

it('uses recovery diagnostics for the stored version in read-only mode', async () => {
  const repository = { getRecoveryStatus: () => ({ mode: 'readOnly', diagnostics: { storedDataVersion: 3 } }), snapshot: vi.fn(), close: vi.fn() };
  render(<ApplicationSection {...base({ loadStoredVersion: undefined, repository: repository as never })} />);
  await waitFor(() => expect(row('Data (schema) version')).toHaveTextContent('stored 3'));
  expect(repository.snapshot).not.toHaveBeenCalled(); void fireEvent;
});

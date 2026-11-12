import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';
import { createLocalSettings } from '../../infrastructure/settings/localSettings';

it('masks keys, preserves unchanged keys and redacts connection errors', async () => {
  localStorage.clear(); const store = createLocalSettings(localStorage);
  store.saveTranscription({ provider: 'openai', model: 'test', endpoint: '', apiKey: 'SENTINEL_FAKE_KEY' });
  const testConnection = vi.fn().mockRejectedValue(new Error('SENTINEL_FAKE_KEY'));
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(<SettingsPage store={store} testConnection={testConnection} />);
  const section = screen.getByRole('group', { name: 'Transcription' });
  expect(within(section).getByLabelText('API key')).toHaveAttribute('type', 'password');
  fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
  expect(store.getTranscription().apiKey).toBe('SENTINEL_FAKE_KEY');
  fireEvent.click(within(section).getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(testConnection).toHaveBeenCalled());
  await screen.findByRole('alert');
  expect(container.textContent).not.toContain('SENTINEL_FAKE_KEY');
  expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_FAKE_KEY'); spy.mockRestore();
});

it('resets parser credentials, endpoint, and model when switching either provider', async () => {
  localStorage.clear(); const store = createLocalSettings(localStorage);
  store.saveParser({ provider: 'anthropic', model: 'anthropic-custom', endpoint: 'https://anthropic.example/v1', apiKey: 'ANTHROPIC_FAKE_KEY' });
  const testConnection = vi.fn().mockResolvedValue(undefined); const fetcher = vi.spyOn(globalThis, 'fetch');
  render(<SettingsPage store={store} testConnection={testConnection} />);
  expect(testConnection).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  const section = within(screen.getByRole('group', { name: 'Statistics parser' }));
  fireEvent.change(section.getByLabelText('Provider'), { target: { value: 'openai' } });
  expect(section.getByLabelText('Endpoint (optional)')).toHaveValue('');
  expect(section.getByLabelText('Model')).not.toHaveValue('anthropic-custom');
  expect(section.getByLabelText('API key')).toHaveValue('');
  fireEvent.click(section.getByRole('button', { name: 'Test connection' }));
  expect(testConnection).not.toHaveBeenCalled();
  fireEvent.change(section.getByLabelText('API key'), { target: { value: 'OPENAI_FAKE_KEY' } });
  fireEvent.click(section.getByRole('button', { name: 'Save' }));
  fireEvent.click(section.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(1));
  expect(testConnection).toHaveBeenLastCalledWith('parser', expect.objectContaining({ provider: 'openai', endpoint: '', apiKey: 'OPENAI_FAKE_KEY' }));
  await section.findByText('Connection successful.');
  fireEvent.change(section.getByLabelText('Provider'), { target: { value: 'anthropic' } });
  expect(section.getByLabelText('Endpoint (optional)')).toHaveValue('');
  expect(section.getByLabelText('API key')).toHaveValue('');
  fireEvent.click(section.getByRole('button', { name: 'Test connection' }));
  expect(testConnection).toHaveBeenCalledTimes(1);
  fireEvent.change(section.getByLabelText('API key'), { target: { value: 'NEW_ANTHROPIC_FAKE_KEY' } });
  fireEvent.click(section.getByRole('button', { name: 'Save' }));
  fireEvent.click(section.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(2));
  expect(testConnection).toHaveBeenLastCalledWith('parser', expect.objectContaining({ provider: 'anthropic', endpoint: '', apiKey: 'NEW_ANTHROPIC_FAKE_KEY' }));
  await section.findByText('Connection successful.');
  fetcher.mockRestore();
});

it('handles storage save and clear failures without leaking their contents', () => {
  localStorage.clear(); const store = createLocalSettings(localStorage); const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(store, 'saveParser').mockImplementation(() => { throw new Error('SENTINEL_FAKE_KEY'); });
  vi.spyOn(store, 'clear').mockImplementation(() => { throw new Error('SENTINEL_FAKE_KEY'); });
  const { container } = render(<SettingsPage store={store} testConnection={vi.fn()} />);
  const section = within(screen.getByRole('group', { name: 'Statistics parser' }));
  fireEvent.click(section.getByRole('button', { name: 'Save' }));
  expect(section.getByRole('alert')).toHaveTextContent(/unable to save/i);
  fireEvent.click(section.getByRole('button', { name: 'Clear key' }));
  expect(section.getByRole('alert')).toHaveTextContent(/unable to clear/i);
  expect(container.textContent).not.toContain('SENTINEL_FAKE_KEY'); expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_FAKE_KEY'); spy.mockRestore();
});

it('handles actual local storage write failures for save and clear', () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('SENTINEL_FAKE_KEY'); } } as unknown as Storage;
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { container } = render(<SettingsPage store={createLocalSettings(storage)} testConnection={vi.fn()} />);
  const section = within(screen.getByRole('group', { name: 'Transcription' }));
  fireEvent.click(section.getByRole('button', { name: 'Save' })); expect(section.getByRole('alert')).toHaveTextContent(/unable to save/i);
  fireEvent.click(section.getByRole('button', { name: 'Clear key' })); expect(section.getByRole('alert')).toHaveTextContent(/unable to clear/i);
  expect(container.textContent).not.toContain('SENTINEL_FAKE_KEY'); expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_FAKE_KEY'); spy.mockRestore();
});

it('disables editing and duplicate actions until a connection test settles', async () => {
  localStorage.clear(); const store = createLocalSettings(localStorage);
  let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; });
  const testConnection = vi.fn().mockReturnValue(pending);
  render(<SettingsPage store={store} testConnection={testConnection} />);
  const section = within(screen.getByRole('group', { name: 'Transcription' }));
  fireEvent.change(section.getByLabelText('API key'), { target: { value: 'SENTINEL_FAKE_KEY' } });
  fireEvent.click(section.getByRole('button', { name: 'Test connection' }));
  for (const control of [section.getByLabelText('Provider'), section.getByLabelText('Model'), section.getByLabelText('Endpoint (optional)'), section.getByLabelText('API key'), section.getByRole('button', { name: 'Save' }), section.getByRole('button', { name: 'Clear key' }), section.getByRole('button', { name: 'Test connection' })]) expect(control).toBeDisabled();
  fireEvent.click(section.getByRole('button', { name: 'Test connection' })); expect(testConnection).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(section.getByText('Connection successful.')).toBeInTheDocument();
  expect(section.getByLabelText('Model')).toBeEnabled();
});

it.each([
  ['Transcription', 'Statistics parser', 'transcription', 'parser'],
  ['Statistics parser', 'Transcription', 'parser', 'transcription'],
] as const)('locks both sections while %s is testing', async (first, second, firstKind, secondKind) => {
  localStorage.clear();
  let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; });
  const testConnection = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined);
  render(<SettingsPage store={createLocalSettings(localStorage)} testConnection={testConnection} />);
  expect(testConnection).not.toHaveBeenCalled();
  const firstSection = within(screen.getByRole('group', { name: first }));
  const secondSection = within(screen.getByRole('group', { name: second }));
  fireEvent.click(secondSection.getByRole('button', { name: 'Save' }));
  expect(secondSection.getByRole('status')).toHaveTextContent('Saved.');
  fireEvent.click(firstSection.getByRole('button', { name: 'Test connection' }));
  expect(testConnection).toHaveBeenCalledTimes(1);
  expect(testConnection.mock.calls[0][0]).toBe(firstKind);
  for (const section of [firstSection, secondSection]) {
    for (const control of [section.getByLabelText('Provider'), section.getByLabelText('Model'), section.getByLabelText('Endpoint (optional)'), section.getByLabelText('API key'), section.getByRole('button', { name: 'Save' }), section.getByRole('button', { name: 'Clear key' }), section.getByRole('button', { name: 'Test connection' })]) expect(control).toBeDisabled();
  }
  fireEvent.click(secondSection.getByRole('button', { name: 'Test connection' }));
  expect(testConnection).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(firstSection.getByRole('status')).toHaveTextContent('Connection successful.');
  expect(secondSection.getByRole('status')).toHaveTextContent('Saved.');
  expect(secondSection.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  fireEvent.click(secondSection.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(testConnection).toHaveBeenCalledTimes(2));
  expect(testConnection.mock.calls[1][0]).toBe(secondKind);
  await secondSection.findByText('Connection successful.');
  expect(firstSection.getByRole('status')).toHaveTextContent('Connection successful.');
});

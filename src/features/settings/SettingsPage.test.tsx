import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

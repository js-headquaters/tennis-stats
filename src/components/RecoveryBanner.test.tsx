/// <reference types="node" />
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecoveryStatus, SafeDiagnostics } from '../application/ports';
import RecoveryBanner from './RecoveryBanner';

const diagnostics: SafeDiagnostics = { code: 'newer-data-version', message: 'This data was saved by a newer version of the app.', failedStep: null, storedDataVersion: 3, appDataVersion: 2, appVersion: '1.0.0', errorName: 'Error' };
const readOnly: RecoveryStatus = { mode: 'readOnly', diagnostics };
let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style); });
afterEach(() => { style.remove(); });
function show(status: RecoveryStatus | undefined, clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => {}) }, reload = vi.fn()) {
  render(<MemoryRouter><RecoveryBanner status={status} clipboard={clipboard} reload={reload} /></MemoryRouter>);
  return { clipboard, reload };
}
function expectTouchTarget(element: Element) {
  expect(parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44);
  expect(parseFloat(getComputedStyle(element).minWidth)).toBeGreaterThanOrEqual(44);
}

describe('RecoveryBanner', () => {
  it('renders nothing in normal mode or while the status is unknown', () => {
    const { container, unmount } = render(<MemoryRouter><RecoveryBanner status={{ mode: 'normal' }} /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement(); unmount();
    const second = render(<MemoryRouter><RecoveryBanner status={undefined} /></MemoryRouter>);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('explains in text that data is preserved, the app is read-only and what the user can do', () => {
    show(readOnly);
    const region = screen.getByRole('region', { name: 'Read-only recovery mode' });
    expect(within(region).getByRole('alert')).toHaveTextContent(/your data is preserved/i);
    expect(region).toHaveTextContent(/read-only/i);
    expect(region).toHaveTextContent(/starting matches, adding or editing games, recording, importing and clearing data are turned off/i);
    expect(region).toHaveTextContent(diagnostics.message);
    const exportLink = within(region).getByRole('link', { name: 'Export a backup in Settings' });
    expect(exportLink).toHaveAttribute('href', '/settings');
    for (const control of [exportLink, within(region).getByRole('button', { name: 'Copy diagnostics' }), within(region).getByRole('button', { name: 'Reload to retry the upgrade' })]) expectTouchTarget(control);
    // No destructive action is offered in recovery mode.
    expect([...within(region).getAllByRole('button'), ...within(region).getAllByRole('link')].map(c => c.textContent).join(' ')).not.toMatch(/reset|delete|clear/i);
  });

  it('copies the safe diagnostics JSON and confirms it', async () => {
    const { clipboard } = show(readOnly);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(clipboard.writeText.mock.calls[0][0])).toEqual(diagnostics);
    expect(await screen.findByRole('status')).toHaveTextContent('Diagnostics copied.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the diagnostics in a selectable box when copying fails', async () => {
    show(readOnly, { writeText: vi.fn<(text: string) => Promise<void>>(async () => { throw new Error('denied'); }) });
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    const box = await screen.findByRole('textbox', { name: 'Diagnostics' });
    expect(box).toHaveAttribute('readonly');
    expect(JSON.parse((box as HTMLTextAreaElement).value)).toEqual(diagnostics);
    expect(screen.getByRole('status')).toHaveTextContent(/couldn't copy automatically/i);
  });

  it('reloads to retry the migration', () => {
    const { reload } = show(readOnly);
    fireEvent.click(screen.getByRole('button', { name: 'Reload to retry the upgrade' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('respects the safe area', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(/\.recovery-banner\s*\{[^}]*env\(safe-area-inset-left\)[^}]*\}/.test(css)).toBe(true);
  });
});

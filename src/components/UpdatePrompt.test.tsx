import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceDraft } from '../domain/model';
import { createUnsafeWorkGuard, createWorkRegistry, type WorkStatus } from '../app/workGuard';
import UpdatePrompt from './UpdatePrompt';

function fakeController(initial = true) {
  let needRefresh = initial; const listeners = new Set<() => void>();
  return {
    getNeedRefresh: () => needRefresh,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    applyUpdate: vi.fn(async () => {}),
    announce() { needRefresh = true; act(() => { listeners.forEach(listener => listener()); }); },
  };
}
function fakeGuard(initial: WorkStatus = 'safe') {
  let status = initial; const listeners = new Set<() => void>();
  return {
    check: vi.fn(async () => status),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: WorkStatus, notify = true) { status = next; if (notify) act(() => { listeners.forEach(listener => listener()); }); },
  };
}
const reloadButton = () => screen.findByRole('button', { name: 'Reload to update' });

describe('UpdatePrompt', () => {
  it('renders nothing and checks nothing without an update', () => {
    const guard = fakeGuard();
    const view = render(<UpdatePrompt controller={fakeController(false)} guard={guard} />);
    expect(view.container).toBeEmptyDOMElement(); expect(guard.check).not.toHaveBeenCalled();
  });

  it('shows an explicit reload action when an update becomes available and never applies it automatically', async () => {
    const controller = fakeController(false);
    render(<UpdatePrompt controller={controller} guard={fakeGuard()} />);
    controller.announce();
    expect(screen.getByRole('status')).toHaveTextContent(/an update is available/i);
    await waitFor(async () => expect(await reloadButton()).toBeEnabled());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(controller.applyUpdate).not.toHaveBeenCalled();
  });

  it('applies the update exactly once on explicit reload, even when double-clicked', async () => {
    const controller = fakeController(); let resolve!: () => void; controller.applyUpdate.mockReturnValue(new Promise<void>(r => { resolve = r; }));
    render(<UpdatePrompt controller={controller} guard={fakeGuard()} />);
    const button = await reloadButton(); await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(controller.applyUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    expect(controller.applyUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(); });
  });

  it('blocks reload while a recording or unsaved edit is active', async () => {
    const controller = fakeController();
    render(<UpdatePrompt controller={controller} guard={fakeGuard('active-work')} />);
    expect(await screen.findByText(/finish or save your recording or draft first/i)).toBeInTheDocument();
    const button = await reloadButton(); expect(button).toBeDisabled();
    fireEvent.click(button); expect(controller.applyUpdate).not.toHaveBeenCalled();
  });

  it('blocks reload while a voice draft is processing or confirming', async () => {
    render(<UpdatePrompt controller={fakeController()} guard={fakeGuard('draft-in-progress')} />);
    expect(await screen.findByText(/a voice draft is still processing or confirming/i)).toBeInTheDocument();
    expect(await reloadButton()).toBeDisabled();
  });

  it('re-evaluates when the guard reports a change', async () => {
    const guard = fakeGuard('active-work');
    render(<UpdatePrompt controller={fakeController()} guard={guard} />);
    await waitFor(async () => expect(await reloadButton()).toBeDisabled());
    guard.set('safe');
    await waitFor(async () => expect(await reloadButton()).toBeEnabled());
    expect(screen.queryByText(/finish or save/i)).not.toBeInTheDocument();
    guard.set('active-work');
    await waitFor(async () => expect(await reloadButton()).toBeDisabled());
  });

  it('re-checks safety at click time and refuses if work started since the last check', async () => {
    const controller = fakeController(); const guard = fakeGuard('safe');
    render(<UpdatePrompt controller={controller} guard={guard} />);
    const button = await reloadButton(); await waitFor(() => expect(button).toBeEnabled());
    guard.set('active-work', false);
    fireEvent.click(button);
    expect(await screen.findByText(/finish or save your recording or draft first/i)).toBeInTheDocument();
    expect(controller.applyUpdate).not.toHaveBeenCalled();
  });

  it('fails closed with a retryable check when safety cannot be determined', async () => {
    const guard = fakeGuard('unknown');
    render(<UpdatePrompt controller={fakeController()} guard={guard} />);
    expect(await screen.findByText(/could not check for unsaved voice drafts/i)).toBeInTheDocument();
    expect(await reloadButton()).toBeDisabled();
    guard.set('safe', false);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(async () => expect(await reloadButton()).toBeEnabled());
  });

  it('treats a throwing guard as unknown', async () => {
    const guard = fakeGuard(); guard.check.mockRejectedValue(new Error('secret'));
    render(<UpdatePrompt controller={fakeController()} guard={guard} />);
    expect(await screen.findByText(/could not check for unsaved voice drafts/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('secret');
  });

  it('shows a safe, recoverable error when applying the update fails', async () => {
    const controller = fakeController(); controller.applyUpdate.mockRejectedValueOnce(new Error('secret-sentinel'));
    render(<UpdatePrompt controller={controller} guard={fakeGuard()} />);
    const button = await reloadButton(); await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/update could not be applied/i);
    expect(document.body).not.toHaveTextContent('secret-sentinel');
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(controller.applyUpdate).toHaveBeenCalledTimes(2));
  });

  it('can be dismissed for now without applying', async () => {
    const controller = fakeController();
    render(<UpdatePrompt controller={controller} guard={fakeGuard()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('button', { name: 'Reload to update' })).not.toBeInTheDocument();
    expect(controller.applyUpdate).not.toHaveBeenCalled();
  });

  it('with the real guard, allows reload with only persisted drafts and blocks on processing or recording', async () => {
    const registry = createWorkRegistry(); let drafts = [{ id: 'a', state: 'ready' }, { id: 'b', state: 'waiting-retry' }, { id: 'c', state: 'error' }, { id: 'd', state: 'recorded' }] as VoiceDraft[];
    const guard = createUnsafeWorkGuard({ registry, listDrafts: async () => drafts });
    render(<UpdatePrompt controller={fakeController()} guard={guard} />);
    await waitFor(async () => expect(await reloadButton()).toBeEnabled());
    let release!: () => void; act(() => { release = registry.hold(); });
    await waitFor(async () => expect(await reloadButton()).toBeDisabled());
    drafts = [...drafts, { id: 'e', state: 'processing' } as VoiceDraft];
    act(() => { release(); });
    expect(await screen.findByText(/a voice draft is still processing or confirming/i)).toBeInTheDocument();
    expect(await reloadButton()).toBeDisabled();
  });
});

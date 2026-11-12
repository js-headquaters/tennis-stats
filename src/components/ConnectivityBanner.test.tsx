import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConnectivityBanner from './ConnectivityBanner';

function fakeConnectivity(initial: boolean) {
  let online = initial; const listeners = new Set<() => void>();
  return {
    isOnline: () => online,
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    set(value: boolean) { online = value; act(() => { listeners.forEach(listener => listener()); }); },
    listeners,
  };
}
function fakeScheduler() {
  const pending: Array<{ action: () => void; delay: number; cancelled: boolean }> = [];
  return { pending, schedule: vi.fn((action: () => void, delay: number) => { const entry = { action, delay, cancelled: false }; pending.push(entry); return () => { entry.cancelled = true; }; }), flush() { act(() => { pending.splice(0).forEach(entry => { if (!entry.cancelled) entry.action(); }); }); } };
}

describe('ConnectivityBanner', () => {
  it('says nothing while online', () => {
    render(<ConnectivityBanner connectivity={fakeConnectivity(true)} scheduler={fakeScheduler()} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('explains what still works and that AI work waits for connectivity while offline', () => {
    render(<ConnectivityBanner connectivity={fakeConnectivity(false)} scheduler={fakeScheduler()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/you're offline/i);
    expect(status).toHaveTextContent(/manual entry, editing, history and dashboards still work/i);
    expect(status).toHaveTextContent(/ai transcription and parsing are waiting for a connection/i);
    expect(status).toHaveTextContent(/recordings and voice drafts stay on this device and can be retried/i);
  });

  it('announces going offline and coming back online, then clears', () => {
    const connectivity = fakeConnectivity(true); const scheduler = fakeScheduler();
    render(<ConnectivityBanner connectivity={connectivity} scheduler={scheduler} />);
    connectivity.set(false);
    expect(screen.getByRole('status')).toHaveTextContent(/you're offline/i);
    connectivity.set(true);
    expect(screen.getByRole('status')).toHaveTextContent(/back online/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/you're offline/i);
    scheduler.flush();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('does not let a stale back-online timer clear a later offline message', () => {
    const connectivity = fakeConnectivity(false); const scheduler = fakeScheduler();
    render(<ConnectivityBanner connectivity={connectivity} scheduler={scheduler} />);
    connectivity.set(true); connectivity.set(false); scheduler.flush();
    expect(screen.getByRole('status')).toHaveTextContent(/you're offline/i);
  });

  it('unsubscribes on unmount', () => {
    const connectivity = fakeConnectivity(true);
    const view = render(<ConnectivityBanner connectivity={connectivity} scheduler={fakeScheduler()} />);
    expect(connectivity.listeners.size).toBe(1);
    view.unmount();
    expect(connectivity.listeners.size).toBe(0);
  });
});

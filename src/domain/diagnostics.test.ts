import { describe, expect, it } from 'vitest';
import { boundText, diagnosticsToDelete } from './diagnostics';

const row = (id: string, startedAt: string, outcome: 'success' | 'error') => ({ id, startedAt, outcome });

describe('boundText', () => {
  it('keeps short text', () => expect(boundText('abc')).toEqual({ value: 'abc', truncated: false, originalLength: 3 }));
  it('truncates long text', () => expect(boundText('x'.repeat(10), 4)).toEqual({ value: 'xxxx', truncated: true, originalLength: 10 }));
});

describe('diagnosticsToDelete', () => {
  it('removes oldest successes first', () => {
    const rows = [row('e1', '2026-01-01', 'error'), row('s2', '2026-01-03', 'success'), row('s1', '2026-01-02', 'success'), row('e2', '2026-01-04', 'error'), row('e3', '2026-01-05', 'error')];
    expect(diagnosticsToDelete(rows, 3)).toEqual(['s1', 's2']);
  });
  it('then removes oldest of the rest', () => {
    const rows = [row('a', '2026-01-02', 'error'), row('b', '2026-01-01', 'error'), row('c', '2026-01-03', 'error'), row('d', '2026-01-04', 'error')];
    expect(diagnosticsToDelete(rows, 3)).toEqual(['b']);
  });
  it('returns [] within cap', () => expect(diagnosticsToDelete([row('a', '2026-01-01', 'error')], 3)).toEqual([]));
  it('breaks ties by array order', () => {
    const rows = [row('a', '2026-01-01', 'success'), row('b', '2026-01-01', 'success'), row('c', '2026-01-01', 'success')];
    expect(diagnosticsToDelete(rows, 1)).toEqual(['a', 'b']);
  });
});

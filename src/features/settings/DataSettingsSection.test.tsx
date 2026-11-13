/// <reference types="node" />
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';
import { createLocalSettings } from '../../infrastructure/settings/localSettings';
import { openDatabase } from '../../infrastructure/db/database';
import { applyImport, previewImport } from '../../application/backupService';
import type { TennisRepository } from '../../application/ports';
import type { FileTransfer } from '../../infrastructure/backup/fileTransfer';
import { FileTransferError } from '../../infrastructure/backup/fileTransfer';
import type { VoiceDraft } from '../../domain/model';

const fixture = (name: string) => readFileSync(resolve(process.cwd(), 'src/test/fixtures', name), 'utf8');
const v1Text = fixture('backup-v1.json');
const v0Text = fixture('backup-v0.json');
const SENTINEL = 'SENTINEL_FAKE_KEY';
// Late evening UTC: the next calendar day in Pacific/Auckland, so the filename proves it uses the clock's UTC date.
const clock = { now: () => '2026-11-12T20:15:00.000Z' };

const repos: TennisRepository[] = [];
let style: HTMLStyleElement;
beforeEach(() => {
  localStorage.clear(); createLocalSettings(localStorage).saveParser({ provider: 'openai', model: 'm', endpoint: '', apiKey: SENTINEL });
  style = document.createElement('style'); style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'); document.head.append(style);
});
afterEach(() => { style.remove(); vi.restoreAllMocks(); repos.forEach(repo => repo.close()); repos.length = 0; });

async function emptyRepo() { const repo = await openDatabase(`data-settings-${crypto.randomUUID()}`); repos.push(repo); return repo; }
async function seededRepo() { const repo = await emptyRepo(); const preview = previewImport(v1Text); await applyImport(preview, 'replace', repo); return repo; }
function fakeTransfer(overrides: Partial<FileTransfer> = {}) {
  const base = { download: vi.fn<FileTransfer['download']>(), readText: vi.fn<FileTransfer['readText']>((file: File) => file.text()) };
  return { ...base, ...overrides } as typeof base;
}
function show(repository: TennisRepository, transfer = fakeTransfer(), testConnection = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<SettingsPage store={createLocalSettings(localStorage)} testConnection={testConnection} data={{ repository, clock, transfer }} />);
  return { ...view, transfer, testConnection, section: within(screen.getByRole('group', { name: 'Data' })) };
}
const json = (text: string, name = 'backup.json') => new File([text], name, { type: 'application/json' });
function choose(section: ReturnType<typeof within>, file: File) { fireEvent.change(section.getByLabelText('Backup file to import'), { target: { files: [file] } }); }
const snapshotText = async (repo: TennisRepository) => JSON.stringify(await repo.snapshot());

it('shows current counts and downloads a versioned backup without keys, with exclusion messaging', async () => {
  const repo = await seededRepo(); const { section, transfer, container } = show(repo);
  expect(await section.findByText(/On this device: 2 matches, 2 opponents, 2 sets, 3 games, 1 tie-break, 0 pending voice drafts\./)).toBeInTheDocument();
  expect(section.getByText(/never include API keys, AI provider settings, or pending voice recordings/)).toBeInTheDocument();
  const exportButton = section.getByRole('button', { name: 'Export backup' });
  expect(exportButton).toHaveTextContent(/^Export$/);
  expect(exportButton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  fireEvent.click(exportButton);
  await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1));
  const [fileName, text] = transfer.download.mock.calls[0];
  expect(fileName).toBe('tennis-stats-backup-v2-2026-11-12.json');
  expect(JSON.parse(text)).toMatchObject({ format: 'tennis-stats-backup', version: 2, exportedAt: '2026-11-12T20:15:00.000Z' });
  expect(text).not.toContain(SENTINEL); expect(text).not.toMatch(/apiKey|parser|transcription/i);
  const status = await section.findByText(/Backup saved as tennis-stats-backup-v2-2026-11-12\.json/);
  expect(status).toHaveTextContent('It does not include API keys, AI provider settings, or pending voice recordings and drafts.');
  expect(container.textContent).not.toContain(SENTINEL);
});

it('reports a failed export without changing data and allows retrying', async () => {
  const repo = await seededRepo(); const transfer = fakeTransfer({ download: vi.fn().mockImplementationOnce(() => { throw new FileTransferError('The browser blocked the download.'); }) });
  const { section } = show(repo, transfer);
  fireEvent.click(section.getByRole('button', { name: 'Export backup' }));
  expect(await section.findByRole('alert')).toHaveTextContent("Couldn't export the backup. The browser blocked the download. Your data was not changed.");
  fireEvent.click(section.getByRole('button', { name: 'Export backup' }));
  await section.findByText(/Backup saved as/);
  expect(section.queryByRole('alert')).not.toBeInTheDocument();
});

it('rejects a non-JSON file with a secret-free error, leaves data untouched, and accepts another file', async () => {
  const repo = await seededRepo(); const before = await snapshotText(repo); const { section, container } = show(repo);
  choose(section, json(`not json ${SENTINEL}`));
  const alert = await section.findByRole('alert');
  expect(alert).toHaveTextContent(/can't be imported/); expect(alert).toHaveTextContent('Your current data was not changed.');
  expect(container.textContent).not.toContain(SENTINEL);
  expect(section.queryByRole('button', { name: /Merge/ })).not.toBeInTheDocument();
  expect(await snapshotText(repo)).toBe(before);
  choose(section, json(v1Text));
  expect(await section.findByRole('table', { name: 'Records in this file' })).toBeInTheDocument();
  expect(section.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows the adapter error for an oversized file without reading data', async () => {
  const repo = await seededRepo(); const before = await snapshotText(repo);
  const transfer = fakeTransfer({ readText: vi.fn().mockRejectedValue(new FileTransferError('That file is larger than 20 MB, so it is not a Tennis Stats backup.')) });
  const { section } = show(repo, transfer);
  choose(section, json('{}'));
  expect(await section.findByRole('alert')).toHaveTextContent('That file is larger than 20 MB');
  expect(await snapshotText(repo)).toBe(before);
});

it('previews counts, warnings and rejected records with reasons before anything is written', async () => {
  const repo = await emptyRepo(); const { section } = show(repo);
  const broken = JSON.parse(v1Text); broken.data.games.push({ ...broken.data.games[0], id: 'game-orphan', setId: 'set-missing' });
  choose(section, json(JSON.stringify(broken)));
  const table = await section.findByRole('table', { name: 'Records in this file' });
  const gamesRow = within(table).getByRole('row', { name: /Games/ });
  expect(within(gamesRow).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['4', '3', '1']);
  const rejected = section.getByRole('list', { name: 'Rejected records' });
  expect(rejected).toHaveTextContent(/Game 4 \(game-orphan\): .+/);
  expect(await snapshotText(repo)).toContain('"matches":[]');
  choose(section, json(v0Text));
  expect(await section.findByRole('list', { name: 'Warnings' })).toHaveTextContent(/draft/i);
});

it('shows merge conflicts before applying and requires an explicit confirmation', async () => {
  const repo = await seededRepo(); const before = await snapshotText(repo);
  const changed = JSON.parse(v1Text); const conflictId = changed.data.matches[0].id as string; changed.data.matches[0].comments = 'Edited elsewhere';
  const { section } = show(repo);
  choose(section, json(JSON.stringify(changed)));
  const conflicts = await section.findByRole('list', { name: 'Merge conflicts (not imported)' });
  expect(conflicts).toHaveTextContent(new RegExp(`Match ${conflictId}: .+`));
  fireEvent.click(section.getByRole('button', { name: 'Merge into current data' }));
  const confirm = section.getByRole('region', { name: 'Confirm merge' });
  expect(confirm).toHaveTextContent(/Existing records are never changed; conflicting records are skipped\./);
  expect(await snapshotText(repo)).toBe(before);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  expect(section.queryByRole('region', { name: 'Confirm merge' })).not.toBeInTheDocument();
  fireEvent.click(section.getByRole('button', { name: 'Merge into current data' }));
  fireEvent.click(section.getByRole('button', { name: 'Confirm merge' }));
  const result = await section.findByRole('table', { name: 'Import result' });
  expect(within(within(result).getByRole('row', { name: /Matches/ })).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['0', '1', '1']);
  expect(section.getByRole('status', { name: 'Import outcome' })).toHaveTextContent('Merge finished.');
  expect(section.queryByRole('table', { name: 'Records in this file' })).not.toBeInTheDocument();
  expect((await repo.getMatchBundle(conflictId))?.match.comments).not.toBe('Edited elsewhere');
});

it('replaces only after a confirmation that warns about overwriting and discarded drafts, then shows fresh counts', async () => {
  const repo = await seededRepo();
  const draft: VoiceDraft = { id: 'd1', matchId: 'gone', setId: '', createdAt: 't', updatedAt: 't', confirmationId: 'c', dataVersion: 2, recording: new Blob(['a']), mimeType: 'audio/mp4', transcripts: [], parsedDraft: null, state: 'ready', error: null };
  const only = JSON.parse(v1Text); const keep = only.data.matches.find((m: { status: string }) => m.status === 'completed');
  only.data.matches = [keep]; only.data.sets = only.data.sets.filter((s: { matchId: string }) => s.matchId === keep.id);
  const setIds = new Set(only.data.sets.map((s: { id: string }) => s.id));
  only.data.games = only.data.games.filter((g: { setId: string }) => setIds.has(g.setId)); only.data.tieBreaks = only.data.tieBreaks.filter((t: { setId: string }) => setIds.has(t.setId));
  const other = JSON.parse(v1Text).data.matches.find((m: { id: string }) => m.id !== keep.id);
  await repo.saveDraft({ ...draft, matchId: other.id });
  const { section } = show(repo);
  await section.findByText(/1 pending voice draft\./);
  choose(section, json(JSON.stringify(only)));
  fireEvent.click(await section.findByRole('button', { name: 'Replace current data' }));
  const confirm = section.getByRole('region', { name: 'Confirm replace' });
  expect(confirm).toHaveTextContent(/deletes all matches, opponents, sets, games and tie-breaks currently on this device/);
  expect(confirm).toHaveTextContent(/Pending voice recordings and drafts are discarded unless their match and set are in this file/);
  expect((await repo.listMatches()).length).toBe(2);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm replace' }));
  expect(await section.findByRole('status', { name: 'Import outcome' })).toHaveTextContent('Replace finished. 0 pending voice drafts kept, 1 discarded.');
  expect((await repo.listMatches()).map(m => m.id)).toEqual([keep.id]);
  expect(await section.findByText(/On this device: 1 match, \d+ opponents?, \d+ sets?, \d+ games?, \d+ tie-breaks?, 0 pending voice drafts\./)).toBeInTheDocument();
  expect(section.queryByRole('region', { name: 'Confirm replace' })).not.toBeInTheDocument();
});

it('keeps current data and the preview when applying fails, with a secret-free error', async () => {
  const repo = await seededRepo(); const before = await snapshotText(repo);
  vi.spyOn(repo, 'replaceAll').mockRejectedValueOnce(new Error(SENTINEL));
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { section, container } = show(repo);
  choose(section, json(v1Text));
  fireEvent.click(await section.findByRole('button', { name: 'Replace current data' }));
  fireEvent.click(section.getByRole('button', { name: 'Confirm replace' }));
  expect(await section.findByRole('alert')).toHaveTextContent("Couldn't import the backup. Your current data was not changed.");
  expect(container.textContent).not.toContain(SENTINEL); expect(JSON.stringify(spy.mock.calls)).not.toContain(SENTINEL);
  expect(await snapshotText(repo)).toBe(before);
  expect(section.getByRole('table', { name: 'Records in this file' })).toBeInTheDocument();
});

it('gates clearing all data behind typing DELETE and leaves AI keys in place', async () => {
  const repo = await seededRepo(); const { section } = show(repo);
  await section.findByText(/On this device: 2 matches/);
  const clear = section.getByRole('button', { name: 'Clear all data' }); const input = section.getByLabelText('Type DELETE to confirm');
  expect(section.getByText(/AI provider settings and API keys are not affected/)).toBeInTheDocument();
  expect(clear).toBeDisabled();
  for (const value of ['delete', 'DELET', ' DELETE', 'DELETE!']) { fireEvent.change(input, { target: { value } }); expect(clear).toBeDisabled(); }
  fireEvent.change(input, { target: { value: 'DELETE' } }); expect(clear).toBeEnabled();
  fireEvent.click(clear); fireEvent.click(clear);
  expect(await section.findByText('All match data on this device was deleted: 2 matches, 2 opponents, 2 sets, 3 games, 1 tie-break, 0 pending voice drafts.')).toBeInTheDocument();
  expect(await section.findByText(/On this device: 0 matches, 0 opponents, 0 sets, 0 games, 0 tie-breaks, 0 pending voice drafts\./)).toBeInTheDocument();
  expect(input).toHaveValue(''); expect(clear).toBeDisabled();
  expect((await repo.snapshot()).matches).toEqual([]);
  expect(createLocalSettings(localStorage).getParser().apiKey).toBe(SENTINEL);
});

it('locks every data action and the AI sections while an import is in flight, and ignores double clicks', async () => {
  const repo = await seededRepo(); let finish!: (text: string) => void;
  const transfer = fakeTransfer({ readText: vi.fn(() => new Promise<string>(done => { finish = done; })) });
  const { section } = show(repo, transfer);
  await section.findByText(/On this device/);
  choose(section, json(v1Text));
  expect(section.getByText('Working… Other settings actions are paused until this finishes.')).toBeInTheDocument();
  const parser = within(screen.getByRole('group', { name: 'Statistics parser' }));
  for (const control of [section.getByRole('button', { name: 'Export backup' }), section.getByLabelText('Backup file to import'), section.getByLabelText('Type DELETE to confirm'), parser.getByRole('button', { name: 'Test connection' }), parser.getByRole('button', { name: 'Save' })]) expect(control).toBeDisabled();
  fireEvent.click(section.getByRole('button', { name: 'Export backup' })); expect(transfer.download).not.toHaveBeenCalled();
  await act(async () => finish(v1Text));
  expect(await section.findByRole('table', { name: 'Records in this file' })).toBeInTheDocument();
  expect(section.getByRole('button', { name: 'Export backup' })).toBeEnabled(); expect(parser.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  const merge = section.getByRole('button', { name: 'Merge into current data' }); fireEvent.click(merge);
  const insert = vi.spyOn(repo, 'insertRecords');
  const confirm = section.getByRole('button', { name: 'Confirm merge' }); fireEvent.click(confirm); fireEvent.click(confirm);
  await section.findByRole('status', { name: 'Import outcome' });
  expect(insert.mock.calls.length).toBeLessThanOrEqual(1);
  fireEvent.click(section.getByRole('button', { name: 'Export backup' })); fireEvent.click(section.getByRole('button', { name: 'Export backup' }));
  await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1));
});

it('runs one action for same-tick double clicks before React re-renders', async () => {
  const repo = await seededRepo(); const { section, transfer } = show(repo);
  await section.findByText(/On this device/);
  const exportButton = section.getByRole('button', { name: 'Export backup' });
  act(() => { exportButton.click(); exportButton.click(); });
  await section.findByText(/Backup saved as/);
  expect(transfer.download).toHaveBeenCalledTimes(1);
  fireEvent.change(section.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  const clear = section.getByRole('button', { name: 'Clear all data' }); const replace = vi.spyOn(repo, 'replaceAll');
  act(() => { clear.click(); clear.click(); exportButton.click(); });
  await section.findByText(/All match data on this device was deleted/);
  expect(replace).toHaveBeenCalledTimes(1); expect(transfer.download).toHaveBeenCalledTimes(1);
});

it('disables data actions while an AI connection test runs', async () => {
  const repo = await seededRepo(); let resolveTest!: () => void;
  const testConnection = vi.fn(() => new Promise<void>(done => { resolveTest = done; }));
  const { section, transfer } = show(repo, fakeTransfer(), testConnection);
  fireEvent.click(within(screen.getByRole('group', { name: 'Transcription' })).getByRole('button', { name: 'Test connection' }));
  expect(section.getByRole('button', { name: 'Export backup' })).toBeDisabled();
  expect(section.getByLabelText('Backup file to import')).toBeDisabled();
  fireEvent.click(section.getByRole('button', { name: 'Export backup' })); expect(transfer.download).not.toHaveBeenCalled();
  await act(async () => resolveTest());
  expect(section.getByRole('button', { name: 'Export backup' })).toBeEnabled();
});

it('gives data controls 44px touch targets', async () => {
  const repo = await seededRepo(); const { section } = show(repo);
  choose(section, json(v1Text));
  await section.findByRole('table', { name: 'Records in this file' });
  fireEvent.click(section.getByRole('button', { name: 'Replace current data' }));
  for (const element of [...section.getAllByRole('button'), section.getByLabelText('Backup file to import'), section.getByLabelText('Type DELETE to confirm')]) {
    expect(parseFloat(getComputedStyle(element).minHeight)).toBeGreaterThanOrEqual(44);
  }
});

it('in read-only recovery mode keeps export working, disables import and clearing with an explanation, and leaves AI settings usable', async () => {
  const name = `data-settings-recovery-${crypto.randomUUID()}`;
  const seeded = await openDatabase(name); await applyImport(previewImport(v1Text), 'replace', seeded); seeded.close();
  const repo = await openDatabase(name, async () => { throw new Error('migration failed'); }); repos.push(repo);
  const insert = vi.spyOn(repo, 'insertRecords'); const replace = vi.spyOn(repo, 'replaceAll');
  const { section, transfer } = show(repo);
  expect(await section.findByText(/On this device: 2 matches/)).toBeInTheDocument();
  const notices = await section.findAllByText(/read-only recovery mode/i);
  expect(notices.map(n => n.textContent).join(' ')).toMatch(/importing is turned off/i);
  expect(notices.map(n => n.textContent).join(' ')).toMatch(/clearing data is turned off/i);
  expect(section.getByLabelText('Backup file to import')).toBeDisabled();
  expect(section.getByLabelText('Type DELETE to confirm')).toBeDisabled();
  expect(section.getByRole('button', { name: 'Clear all data' })).toBeDisabled();
  fireEvent.click(section.getByRole('button', { name: 'Export backup' }));
  await waitFor(() => expect(transfer.download).toHaveBeenCalledTimes(1));
  expect(await section.findByText(/Backup saved as/)).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Statistics parser' })).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});

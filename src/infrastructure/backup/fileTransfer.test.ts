import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserFileTransfer, FileTransferError, MAX_IMPORT_BYTES } from './fileTransfer';

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

function fakeUrls() {
  const created: Blob[] = [];
  return { created, urls: { createObjectURL: vi.fn((blob: Blob) => { created.push(blob); return 'blob:backup-1'; }), revokeObjectURL: vi.fn() } };
}

it('downloads the text through a temporary anchor with the given filename and revokes the URL', async () => {
  const { created, urls } = fakeUrls(); const later: Array<() => void> = [];
  const clicks: Array<{ href: string; download: string; attached: boolean }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.href, download: this.download, attached: document.body.contains(this) }); });
  const transfer = createBrowserFileTransfer({ document, urls, defer: callback => later.push(callback) });
  transfer.download('tennis-stats-backup-v1-2026-11-12.json', '{"a":1}\n');
  expect(clicks).toEqual([{ href: 'blob:backup-1', download: 'tennis-stats-backup-v1-2026-11-12.json', attached: true }]);
  expect(document.querySelector('a')).toBeNull();
  expect(created[0].type).toBe('application/json');
  expect(await created[0].text()).toBe('{"a":1}\n');
  expect(urls.revokeObjectURL).not.toHaveBeenCalled();
  later.forEach(callback => callback());
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:backup-1');
});

it('revokes the URL and removes the anchor even when the click fails', () => {
  const { urls } = fakeUrls();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });
  const transfer = createBrowserFileTransfer({ document, urls, defer: callback => callback() });
  expect(() => transfer.download('x.json', '{}')).toThrow(FileTransferError);
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:backup-1');
  expect(document.querySelector('a')).toBeNull();
});

it('reads a chosen file as text', async () => {
  const transfer = createBrowserFileTransfer();
  await expect(transfer.readText(new File(['{"format":"x"}'], 'backup.json', { type: 'application/json' }))).resolves.toBe('{"format":"x"}');
});

it('rejects files over the size limit before reading them', async () => {
  const transfer = createBrowserFileTransfer();
  const file = new File(['x'], 'huge.json'); Object.defineProperty(file, 'size', { value: MAX_IMPORT_BYTES + 1 });
  const text = vi.spyOn(file, 'text');
  await expect(transfer.readText(file)).rejects.toThrow(/larger than 20 MB/);
  await expect(transfer.readText(file)).rejects.toBeInstanceOf(FileTransferError);
  expect(text).not.toHaveBeenCalled();
});

it('reports unreadable files without echoing their contents or name details', async () => {
  const transfer = createBrowserFileTransfer(); const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const file = new File(['SENTINEL_CONTENT'], 'backup.json'); vi.spyOn(file, 'text').mockRejectedValue(new Error('SENTINEL_CONTENT'));
  const failure = await transfer.readText(file).catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(FileTransferError);
  expect(String((failure as Error).message)).not.toContain('SENTINEL_CONTENT');
  expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL_CONTENT');
});

it('rejects an empty file with a clear message', async () => {
  await expect(createBrowserFileTransfer().readText(new File([], 'empty.json'))).rejects.toThrow(/empty/);
});

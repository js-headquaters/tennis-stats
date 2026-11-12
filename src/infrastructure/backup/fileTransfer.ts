/** Largest backup file accepted for import, matching the backup service's `MAX_BACKUP_CHARS` text limit. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Error whose message is safe to show the user: it never contains file contents. */
export class FileTransferError extends Error { override name = 'FileTransferError'; }

/** Moves backup text to and from the user's files. Components depend on this, so tests can use a fake. */
export interface FileTransfer {
  /** Offers `text` to the user as a JSON file download named `fileName`. */
  download(fileName: string, text: string): void;
  /** Reads a file the user picked as text. Rejects with a `FileTransferError` if it is empty, too large or unreadable. */
  readText(file: File): Promise<string>;
}

interface BrowserDeps {
  document?: Document;
  urls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  /** Runs the URL cleanup after the browser has started the download; some WebKit versions abort it if revoked immediately. */
  defer?: (callback: () => void) => void;
}

export function createBrowserFileTransfer({ document: doc = document, urls = URL, defer = callback => { setTimeout(callback, 1000); } }: BrowserDeps = {}): FileTransfer {
  return {
    download(fileName, text) {
      const url = urls.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = doc.createElement('a');
      anchor.href = url; anchor.download = fileName; anchor.rel = 'noopener'; anchor.hidden = true;
      doc.body.append(anchor);
      let clicked = false;
      try { anchor.click(); clicked = true; }
      catch { throw new FileTransferError('The browser blocked the download.'); }
      finally {
        anchor.remove();
        if (clicked) defer(() => urls.revokeObjectURL(url)); else urls.revokeObjectURL(url);
      }
    },
    async readText(file) {
      if (file.size > MAX_IMPORT_BYTES) throw new FileTransferError('That file is larger than 20 MB, so it is not a Tennis Stats backup.');
      if (file.size === 0) throw new FileTransferError('That file is empty.');
      try { return await file.text(); }
      catch { throw new FileTransferError('The file could not be read. Choose it again or pick another file.'); }
    },
  };
}

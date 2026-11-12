/** Inline explanation shown next to write controls that are disabled by read-only recovery mode. */
export default function ReadOnlyNotice({ disabled }: { disabled: string }) {
  return <p className="read-only-notice" role="note">Read-only recovery mode: {disabled} turned off so your saved data stays unchanged. Your data is preserved; you can still view it and export a backup in Settings.</p>;
}

import { useState } from 'react';
import { clearAllData } from '../../application/backupService';
import type { Exclusive, WithRepository } from './DataSettingsSection';
import { countsText } from './dataLabels';

/** The exact, case-sensitive word the user must type before clearing all data. */
export const CLEAR_CONFIRMATION_WORD = 'DELETE';

export function ClearDataPanel({ exclusive, withRepository, onChanged }: { exclusive: Exclusive; withRepository: WithRepository; onChanged: () => void }) {
  const [typed, setTyped] = useState(''); const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const clear = () => exclusive(async () => {
    setMessage(null);
    try {
      const removed = await withRepository(clearAllData);
      setTyped(''); setMessage({ error: false, text: `All match data on this device was deleted: ${countsText(removed)}.` }); onChanged();
    } catch { setMessage({ error: true, text: "Couldn't clear data. Nothing was deleted. Try again." }); }
  });
  return <section aria-labelledby="clear-data-heading">
    <h3 id="clear-data-heading">Clear all data</h3>
    <p><strong>Warning:</strong> this permanently deletes all matches, opponents, statistics and pending voice recordings and drafts on this device. It cannot be undone; export a backup first if you might need this data. AI provider settings and API keys are not affected; clear them in the sections above.</p>
    <label>Type {CLEAR_CONFIRMATION_WORD} to confirm <input value={typed} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={event => setTyped(event.target.value)} /></label>
    <button type="button" disabled={typed !== CLEAR_CONFIRMATION_WORD} onClick={clear}>Clear all data</button>
    {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
  </section>;
}

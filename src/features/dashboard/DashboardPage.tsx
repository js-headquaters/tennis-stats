import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { dependencies } from '../../app/dependencies';
import type { MatchBundle } from '../../domain/model';

export default function DashboardPage() {
  const [active, setActive] = useState<MatchBundle>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const repository = await dependencies.openDatabase();
        try { const match = await repository.getActiveMatch(); if (!cancelled) setActive(match); }
        finally { repository.close(); }
      } catch { if (!cancelled) setError('Unable to load the active match.'); }
    })();
    return () => { cancelled = true; };
  }, []);
  return <section><h1>Home</h1><p>Track your tennis matches.</p>{error && <p role="alert">{error}</p>}{active && <section aria-label="Active match"><h2>Match in progress</h2><p>Against {active.opponent.name}</p><Link className="action-link" to={`/matches/${active.match.id}/live`}>Resume match</Link></section>}<Link className="action-link" to="/matches/new">Start new match</Link></section>;
}

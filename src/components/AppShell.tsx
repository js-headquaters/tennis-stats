import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { House, List, Settings } from 'lucide-react';
import type { ConnectivitySource, UpdateController } from '../app/pwa';
import type { UnsafeWorkGuard } from '../app/workGuard';
import { dependencies } from '../app/dependencies';
import type { RecoveryStatus } from '../application/ports';
import ConnectivityBanner from './ConnectivityBanner';
import RecoveryBanner from './RecoveryBanner';
import UpdatePrompt from './UpdatePrompt';
import IconLabel from './IconLabel';

type Props = { connectivity?: ConnectivitySource; updateController?: UpdateController; workGuard?: UnsafeWorkGuard; loadRecoveryStatus?: () => Promise<RecoveryStatus> };

export default function AppShell({ connectivity, updateController, workGuard, loadRecoveryStatus = dependencies.loadRecoveryStatus }: Props) {
  const [recovery, setRecovery] = useState<RecoveryStatus>();
  useEffect(() => {
    let cancelled = false;
    // An unreadable database is reported by each page's own load error; the banner is only for read-only recovery.
    loadRecoveryStatus().then(status => { if (!cancelled) setRecovery(status); }, () => {});
    return () => { cancelled = true; };
  }, [loadRecoveryStatus]);
  return <div className="app-shell"><header className="app-header"><span>Tennis Stats</span></header>
    <RecoveryBanner status={recovery} />
    <div className="app-lifecycle"><ConnectivityBanner connectivity={connectivity} /><UpdatePrompt controller={updateController} guard={workGuard} /></div>
    <main><Outlet /></main><nav aria-label="Main navigation" className="mobile-nav"><NavLink to="/"><IconLabel icon={House}>Home</IconLabel></NavLink><NavLink to="/matches"><IconLabel icon={List}>Matches</IconLabel></NavLink><NavLink to="/settings"><IconLabel icon={Settings}>Settings</IconLabel></NavLink></nav></div>;
}

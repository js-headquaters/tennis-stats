import { NavLink, Outlet } from 'react-router-dom';
import type { ConnectivitySource, UpdateController } from '../app/pwa';
import type { UnsafeWorkGuard } from '../app/workGuard';
import ConnectivityBanner from './ConnectivityBanner';
import UpdatePrompt from './UpdatePrompt';

type Props = { connectivity?: ConnectivitySource; updateController?: UpdateController; workGuard?: UnsafeWorkGuard };

export default function AppShell({ connectivity, updateController, workGuard }: Props) {
  return <div className="app-shell"><header className="app-header"><span>Tennis Stats</span></header>
    <div className="app-lifecycle"><ConnectivityBanner connectivity={connectivity} /><UpdatePrompt controller={updateController} guard={workGuard} /></div>
    <main><Outlet /></main><nav aria-label="Main navigation" className="mobile-nav"><NavLink to="/">Home</NavLink><NavLink to="/matches">Matches</NavLink><NavLink to="/settings">Settings</NavLink></nav></div>;
}

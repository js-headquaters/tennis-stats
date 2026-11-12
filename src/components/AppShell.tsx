import { NavLink, Outlet } from 'react-router-dom';

export default function AppShell() { return <div className="app-shell"><header className="app-header"><span>Tennis Stats</span></header><main><Outlet /></main><nav aria-label="Main navigation" className="mobile-nav"><NavLink to="/">Home</NavLink><NavLink to="/matches">Matches</NavLink><NavLink to="/settings">Settings</NavLink></nav></div>; }

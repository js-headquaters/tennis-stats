import { createHashRouter } from 'react-router-dom';
import AppShell from '../components/AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import StartMatchPage from '../features/matches/StartMatchPage';
import ActiveMatchPage from '../features/matches/ActiveMatchPage';
import SettingsPage from '../features/settings/SettingsPage';
import RecordPage from '../features/voice/RecordPage';
import DraftReviewPage from '../features/voice/DraftReviewPage';

function Placeholder({ title }: { title: string }) { return <><h1>{title}</h1><p>Coming soon.</p></>; }

export const router = createHashRouter([{ element: <AppShell />, children: [
  { path: '/', element: <DashboardPage /> },
  { path: '/matches', element: <Placeholder title="Matches" /> },
  { path: '/matches/new', element: <StartMatchPage /> },
  { path: '/matches/:matchId', element: <Placeholder title="Match" /> },
  { path: '/matches/:matchId/live', element: <ActiveMatchPage /> },
  { path: '/matches/:matchId/record', element: <RecordPage /> },
  { path: '/voice/:draftId', element: <DraftReviewPage /> },
  { path: '/settings', element: <SettingsPage /> },
]}]);

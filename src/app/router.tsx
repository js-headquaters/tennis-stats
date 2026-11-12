import { createHashRouter } from 'react-router-dom';
import AppShell from '../components/AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import StartMatchPage from '../features/matches/StartMatchPage';
import ActiveMatchPage from '../features/matches/ActiveMatchPage';
import MatchHistoryPage from '../features/matches/MatchHistoryPage';
import MatchDetailsPage from '../features/matches/MatchDetailsPage';
import SettingsPage from '../features/settings/SettingsPage';
import RecordPage from '../features/voice/RecordPage';
import DraftReviewPage from '../features/voice/DraftReviewPage';

export const router = createHashRouter([{ element: <AppShell />, children: [
  { path: '/', element: <DashboardPage /> },
  { path: '/matches', element: <MatchHistoryPage /> },
  { path: '/matches/new', element: <StartMatchPage /> },
  { path: '/matches/:matchId', element: <MatchDetailsPage /> },
  { path: '/matches/:matchId/live', element: <ActiveMatchPage /> },
  { path: '/matches/:matchId/record', element: <RecordPage /> },
  { path: '/voice/:draftId', element: <DraftReviewPage /> },
  { path: '/settings', element: <SettingsPage /> },
]}]);

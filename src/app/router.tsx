import { createHashRouter, type RouteObject } from 'react-router-dom';
import AppShell from '../components/AppShell';
import DashboardPage from '../features/dashboard/DashboardPage';
import StartMatchPage from '../features/matches/StartMatchPage';
import ActiveMatchPage from '../features/matches/ActiveMatchPage';
import MatchHistoryPage from '../features/matches/MatchHistoryPage';
import MatchDetailsPage from '../features/matches/MatchDetailsPage';
import SettingsPage from '../features/settings/SettingsPage';
import RecordPage from '../features/voice/RecordPage';
import DraftReviewPage from '../features/voice/DraftReviewPage';
import { AppErrorPage, NotFoundPage, RouteErrorPage } from '../components/RouteFallback';

// Page errors and unknown paths render inside the layout (navigation stays); a failure of the layout itself falls back to the standalone AppErrorPage.
export const routes: RouteObject[] = [{ element: <AppShell />, errorElement: <AppErrorPage />, children: [{ errorElement: <RouteErrorPage />, children: [
  { path: '/', element: <DashboardPage /> },
  { path: '/matches', element: <MatchHistoryPage /> },
  { path: '/matches/new', element: <StartMatchPage /> },
  { path: '/matches/:matchId', element: <MatchDetailsPage /> },
  { path: '/matches/:matchId/live', element: <ActiveMatchPage /> },
  { path: '/matches/:matchId/record', element: <RecordPage /> },
  { path: '/voice/:draftId', element: <DraftReviewPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '*', element: <NotFoundPage /> },
]}]}];

export const router = createHashRouter(routes);

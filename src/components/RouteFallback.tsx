import { Link } from 'react-router-dom';

function RecoveryLinks() {
  return <p className="route-fallback-links"><Link className="touch-link" to="/">Home</Link> <Link className="touch-link" to="/matches">Matches</Link> <Link className="touch-link" to="/settings">Settings</Link></p>;
}

export function NotFoundPage() {
  return <section className="route-fallback"><h1>Page not found</h1><p>This page does not exist. Use a link below to go back.</p><RecoveryLinks /></section>;
}

// Fixed text on purpose: error messages can contain stored data, so nothing from the error is rendered or logged here.
export function RouteErrorPage() {
  return <section className="route-fallback" role="alert"><h1>Something went wrong</h1><p>This page could not be shown. Your saved data is unchanged. Use a link below to go back.</p><RecoveryLinks /></section>;
}

// Standalone fallback for a failure of the app layout itself: no shell, so it carries its own navigation.
export function AppErrorPage() {
  return <main className="route-fallback"><RouteErrorPage /><nav aria-label="Main navigation" className="mobile-nav"><Link to="/">Home</Link><Link to="/matches">Matches</Link><Link to="/settings">Settings</Link></nav></main>;
}

import { Link } from 'react-router-dom';

export default function DashboardPage() { return <section><h1>Home</h1><p>Track your tennis matches.</p><Link className="action-link" to="/matches/new">Start new match</Link></section>; }

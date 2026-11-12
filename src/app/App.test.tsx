import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('app shell', () => {
  it('exposes Home, Matches, and Settings in mobile navigation', () => {
    render(<App />);

    expect(screen.getByRole('navigation', { name: /main/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Matches' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('provides an accessible link to start a new match', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: 'Start new match' })).toBeInTheDocument();
  });
});

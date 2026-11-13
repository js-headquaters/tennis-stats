import { render, screen } from '@testing-library/react';
import { Home } from 'lucide-react';
import { expect, it } from 'vitest';
import IconLabel from './IconLabel';

it('renders a decorative Lucide icon beside visible action text', () => {
  const { container } = render(<IconLabel icon={Home}>Home</IconLabel>);
  expect(screen.getByText('Home')).toHaveClass('icon-label-text');
  const icon = container.querySelector('svg');
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).not.toHaveAttribute('aria-label');
});

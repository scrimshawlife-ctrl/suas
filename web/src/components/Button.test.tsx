import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '../lib/cn';
import { Button } from './Button';

describe('Button', () => {
  it('passes onClick through to internal and external links', async () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <MemoryRouter>
        <Button href="/home" onClick={onClick}>
          Inside
        </Button>
        <Button href="https://example.invalid" onClick={onClick}>
          Outside
        </Button>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Inside' }));
    await userEvent.click(screen.getByRole('link', { name: 'Outside' }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('renders a disabled link button as a real disabled button', () => {
    render(
      <MemoryRouter>
        <Button href="/home" variant="disabled">
          Unavailable
        </Button>
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Unavailable' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('lets a caller className override the variant defaults', () => {
    render(
      <Button variant="ghost" className="px-0 hover:bg-transparent hover:text-harbor-tint">
        Sign out
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Sign out' });
    expect(button).toHaveClass('px-0', 'hover:bg-transparent', 'hover:text-harbor-tint');
    expect(button).not.toHaveClass('px-4.5', 'hover:bg-mist', 'hover:text-ink');
  });
});

describe('cn', () => {
  it('keeps px-named font sizes and text colours apart', () => {
    expect(cn('text-18 text-ink', 'text-white')).toBe('text-18 text-white');
    expect(cn('text-white', 'text-24')).toBe('text-white text-24');
    expect(cn('rounded-8', 'rounded-pill')).toBe('rounded-pill');
  });
});

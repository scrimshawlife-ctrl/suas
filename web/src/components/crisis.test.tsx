import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { CrisisPanel } from './CrisisPanel';
import { CrisisStrip } from './CrisisStrip';
import { Footer } from './Footer';

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** Reading-order text of a region: block elements and links are separated by a space. */
const text = (element: HTMLElement) =>
  element.innerHTML
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<\/?(h\d|p|div|section|aside|footer|a)\b[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1')
    .trim();

describe('D-012 crisis copy', () => {
  it('renders the crisis strip verbatim as plain white links, as the boards draw it', () => {
    wrap(<CrisisStrip />);
    const strip = screen.getByRole('complementary', { name: 'Crisis support' });
    expect(text(strip)).toBe(
      'Emergency: Call 911 Crisis support: Call or text 988 Practical support: Continue with SUAS',
    );
    expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    expect(screen.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
    expect(screen.getByRole('link', { name: 'Text 988' })).toHaveAttribute('href', 'sms:988');
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveClass('inline-flex', 'min-h-11', 'min-w-11', 'text-white');
      expect(link).not.toHaveClass('bg-sos');
      expect(link.querySelector('svg')).toBeNull();
    }
  });

  it('renders the compact panel verbatim, with 988 in the SOS style and a phone icon', () => {
    wrap(<CrisisPanel />);
    const panel = screen.getByRole('region', { name: 'Need help right now?' });
    expect(text(panel)).toBe(
      'Need help right now? ' +
        'If you are in immediate danger, have a medical emergency, or believe someone may be seriously harmed, call 911 or go to the nearest emergency department. ' +
        'If you are experiencing suicidal thoughts, severe emotional distress, or a mental health crisis, call or text the 988 Suicide & Crisis Lifeline at 988. ' +
        'Call 911 Call or text 988 ' +
        'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care. ' +
        'More crisis options',
    );
    const call988 = screen.getByRole('link', { name: 'Call or text 988' });
    expect(call988).toHaveAttribute('href', 'tel:988');
    expect(call988).toHaveClass('bg-sos', 'text-white', 'border-white');
    expect(call988.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Call 911' })).toHaveClass('bg-sos');
  });

  it('renders the full panel with the "not an emergency service" line in the body', () => {
    wrap(<CrisisPanel layout="full" />);
    const panel = screen.getByRole('region', { name: 'Need help right now?' });
    expect(text(panel)).toContain(
      'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care.',
    );
    expect(screen.getByRole('link', { name: 'Continue with SUAS support' })).toHaveAttribute(
      'href',
      '/home',
    );
  });

  it('shows the Veterans Crisis Line only when asked, with the default link colour', () => {
    const { rerender } = wrap(<Footer />);
    expect(screen.queryByText(/Veterans Crisis Line/)).toBeNull();
    expect(text(screen.getByRole('contentinfo'))).toBe(
      'SUAS coordinates community support. It does not provide emergency medical care or emergency dispatch. ' +
        'For immediate danger, call 911. For suicide or emotional crisis support, call or text 988.',
    );
    rerender(
      <MemoryRouter>
        <Footer showVeteransCrisisLine />
      </MemoryRouter>,
    );
    expect(text(screen.getByRole('contentinfo'))).toContain(
      'Veterans Crisis Line: Dial 988, then press 1 · Text 838255',
    );
    for (const link of screen.getAllByRole('link', { name: '988' })) {
      expect(link).not.toHaveClass('text-sos');
    }
    expect(screen.getByRole('link', { name: '838255' })).toHaveAttribute('href', 'sms:838255');
  });
});

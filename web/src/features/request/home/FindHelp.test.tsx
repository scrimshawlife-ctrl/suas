import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Me } from '../../../api/types';
import { FindHelp, phoneTag } from './FindHelp';

type Card = Me['categories'][number];

const food: Card = { label: 'Food', disposition: 'OPERATIONAL', category: 'FOOD', note: null };
const housing: Card = {
  label: 'Housing',
  disposition: 'OPERATIONAL',
  category: 'SHELTER',
  note: 'Temporary shelter. Long-term housing placement is not available yet.',
};
const counseling: Card = {
  label: 'Counseling',
  disposition: 'COMING_SOON',
  category: null,
  note: 'Not available yet. This does not create a request.',
};
const activities: Card = {
  label: 'Activities',
  disposition: 'INFORMATION_ONLY',
  category: null,
  note: 'Community listings only. This does not create a request.',
};

function show(categories: Card[]) {
  render(
    <MemoryRouter>
      <FindHelp categories={categories} />
    </MemoryRouter>,
  );
}

describe('FindHelp', () => {
  it('draws exactly the categories the API sent, in order', () => {
    show([housing, food]);
    const names = screen.getAllByRole('link').map((link) => link.textContent);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain('Housing');
    expect(names[1]).toContain('Food');
    expect(screen.queryByText('Transportation')).not.toBeInTheDocument();
  });

  it('links a released category to its lowercased resources page', () => {
    show([food, housing]);
    expect(screen.getByRole('link', { name: /Food/ })).toHaveAttribute('href', '/resources/food');
    expect(screen.getByRole('link', { name: /Housing/ })).toHaveAttribute(
      'href',
      '/resources/shelter',
    );
  });

  it('never turns a coming-soon or info-only entry into a request link', () => {
    show([food, counseling, activities]);
    const links = screen.getAllByRole('link');
    for (const link of links) expect(link.getAttribute('href')).not.toMatch(/^\/request/);
    expect(screen.getAllByText('Coming soon').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Info only').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Counseling/ })).toHaveAttribute(
      'href',
      '/resources/counseling',
    );
  });

  it('skips a released entry that has no category to link to', () => {
    show([{ ...food, category: null }]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shortens the Housing note to its first sentence for phones', () => {
    expect(phoneTag(housing.note ?? '')).toBe('Temporary shelter');
    expect(phoneTag('One sentence only.')).toBe('One sentence only');
  });

  it('compact mode expands in place, reports its state, and collapses again', async () => {
    const transport: Card = {
      label: 'Transportation',
      disposition: 'OPERATIONAL',
      category: 'TRANSPORTATION',
      note: null,
    };
    const extra: Card = {
      label: 'Peer support',
      disposition: 'OPERATIONAL',
      category: 'PEER_SUPPORT',
      note: null,
    };
    render(
      <MemoryRouter>
        <FindHelp categories={[food, housing, transport, extra, counseling]} compact />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(3);
    const more = screen.getByRole('button', {
      name: /All categories, including Peer support and Counseling/,
    });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(more);
    expect(screen.getByRole('link', { name: /Peer support/ })).toBeInTheDocument();
    const fewer = screen.getByRole('button', { name: 'Show fewer categories' });
    expect(fewer).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(fewer);
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /All categories/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('has no collapse control outside compact mode', () => {
    show([food, housing]);
    expect(screen.queryByRole('button', { name: 'Show fewer categories' })).not.toBeInTheDocument();
  });
});

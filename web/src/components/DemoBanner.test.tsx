import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemoBanner } from './DemoBanner';

// R16.4 (contributor proposal, not released): exact banner copy, and nothing when off.
describe('DemoBanner', () => {
  it('shows the DEMO label and the banner copy when enabled', () => {
    render(<DemoBanner enabled />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(
      "DEMODemo site. Everything here is synthetic sample data for demonstration, and nobody monitors it. Don't enter real personal information.",
    );
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<DemoBanner enabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RadioCardGroup } from './RadioCardGroup';

describe('RadioCardGroup', () => {
  it('does not warn when value is given without onValueChange', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <RadioCardGroup
        legend="How connected?"
        name="q"
        value="b"
        options={[
          { value: 'a', title: 'A' },
          { value: 'b', title: 'B' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'B' })).toBeChecked();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const OPTIONS = [
  { value: 'FOOD', label: 'Food' },
  { value: 'HOUSING', label: 'Housing' },
] as const;

/** Adds an option the caller never gave, as injected or stale markup would. */
function choose(select: HTMLSelectElement, value: string) {
  if (!Array.from(select.options).some((option) => option.value === value))
    select.append(new Option(value, value));
  fireEvent.change(select, { target: { value } });
}

describe('Select onValueChange', () => {
  it('emits a value from options', () => {
    const onValueChange = vi.fn();
    render(<Select label="Category" options={OPTIONS} onValueChange={onValueChange} />);
    choose(screen.getByLabelText('Category'), 'HOUSING');
    expect(onValueChange).toHaveBeenCalledWith('HOUSING');
  });

  it.each(['BOGUS', ''])('never emits %j when it is not one of the options', (value) => {
    const onValueChange = vi.fn();
    const onChange = vi.fn();
    render(
      <Select
        label="Category"
        options={OPTIONS}
        onChange={onChange}
        onValueChange={onValueChange}
      />,
    );
    choose(screen.getByLabelText('Category'), value);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('emits the empty value when the placeholder is chosen again', () => {
    const onValueChange = vi.fn();
    const chosen: (typeof OPTIONS)[number]['value'] | '' = 'FOOD';
    render(
      <Select
        label="Category"
        placeholder="Choose one"
        options={OPTIONS}
        value={chosen}
        onValueChange={onValueChange}
      />,
    );
    choose(screen.getByLabelText('Category'), '');
    expect(onValueChange).toHaveBeenCalledWith('');
  });
});

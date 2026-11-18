import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  // Type checks (tsc runs on tests): '' belongs to the placeholder, not to `T`.
  it('takes or emits the empty value only with a placeholder', () => {
    const takeOption = (value: 'FOOD' | 'HOUSING') => value;
    const takeOptionOrNone = vi.fn((value: 'FOOD' | 'HOUSING' | '') => value);
    render(
      <>
        <Select
          label="No placeholder"
          options={OPTIONS}
          // @ts-expect-error: '' is not an option, and there is no placeholder to stand for it.
          value=""
          onChange={() => undefined}
        />
        <Select
          label="Placeholder"
          placeholder="Choose one"
          options={OPTIONS}
          // @ts-expect-error: with a placeholder the Select can emit '', which this does not take.
          onValueChange={takeOption}
        />
        <Select
          label="Typed"
          placeholder="Choose one"
          options={OPTIONS}
          value="FOOD"
          onValueChange={takeOptionOrNone}
        />
      </>,
    );
    choose(screen.getByLabelText('Typed'), '');
    expect(takeOptionOrNone).toHaveBeenCalledWith('');
  });
});

describe('Select states', () => {
  it('a disabled select takes no choice', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Select label="Category" options={OPTIONS} disabled onValueChange={onValueChange} />);
    const select = screen.getByLabelText('Category');
    expect(select).toBeDisabled();
    await user.selectOptions(select, 'HOUSING').catch(() => undefined);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('a required select with an error is marked invalid and described by the error', () => {
    render(
      <Select
        label="Category"
        placeholder="Choose one"
        options={OPTIONS}
        value=""
        required
        error="Choose a category."
        onChange={() => undefined}
      />,
    );
    const select = screen.getByLabelText('Category');
    expect(select).toBeRequired();
    expect(select).toBeInvalid();
    expect(select).toHaveAccessibleDescription('Choose a category.');
  });

  it('two selects on one page keep their own labels and values', async () => {
    const user = userEvent.setup();
    const onCategory = vi.fn();
    const onSize = vi.fn();
    render(
      <>
        <Select label="Category" options={OPTIONS} onValueChange={onCategory} />
        <Select
          label="Size"
          options={[
            { value: 'SMALL', label: 'Small' },
            { value: 'LARGE', label: 'Large' },
          ]}
          onValueChange={onSize}
        />
      </>,
    );
    const category = screen.getByLabelText('Category');
    const size = screen.getByLabelText('Size');
    expect(category.id).not.toBe(size.id);
    await user.selectOptions(size, 'LARGE');
    expect(onSize).toHaveBeenCalledWith('LARGE');
    expect(onCategory).not.toHaveBeenCalled();
    await user.selectOptions(category, 'FOOD');
    expect(onCategory).toHaveBeenCalledWith('FOOD');
    expect(onSize).toHaveBeenCalledTimes(1);
  });
});

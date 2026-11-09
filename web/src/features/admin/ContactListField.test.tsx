import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ContactListField } from './ContactListField';
import type { ContactRow } from './draft-form';

function Harness({ initial, error }: { initial: ContactRow[]; error?: string }) {
  const [rows, setRows] = useState(initial);
  return (
    <>
      <ContactListField rows={rows} onChange={setRows} error={error} />
      <output data-testid="rows">{JSON.stringify(rows)}</output>
    </>
  );
}

const rowsOf = () => JSON.parse(screen.getByTestId('rows').textContent ?? '[]') as ContactRow[];

describe('ContactListField', () => {
  it('adds rows up to three and then disables Add', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    expect(screen.getByText('No contact method recorded.')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add a contact method' });
    await user.click(add);
    await user.click(add);
    await user.click(add);
    expect(rowsOf()).toHaveLength(3);
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.click(add);
    expect(rowsOf()).toHaveLength(3);
    expect(screen.getByLabelText('Contact 3')).toBeInTheDocument();
  });

  it('removes the chosen row and keeps the order of the others', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[
          { kind: 'PHONE', value: '408-555-0100' },
          { kind: 'URL', value: 'https://a.example.invalid' },
          { kind: 'EMAIL', value: 'a@example.invalid' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove contact 2' }));
    expect(rowsOf().map((row) => row.kind)).toEqual(['PHONE', 'EMAIL']);
    expect(screen.getByRole('button', { name: 'Add a contact method' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('changes the kind and the value of one row', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[{ kind: 'PHONE', value: '' }]} />);
    await user.selectOptions(screen.getByLabelText('Contact 1 kind'), 'URL');
    await user.type(screen.getByLabelText('Contact 1'), 'https://b.example.invalid');
    expect(rowsOf()).toEqual([{ kind: 'URL', value: 'https://b.example.invalid' }]);
  });

  it('shows the error and marks only the empty rows invalid', () => {
    render(
      <Harness
        initial={[
          { kind: 'PHONE', value: '408-555-0100' },
          { kind: 'URL', value: '' },
        ]}
        error="Enter each contact method, or remove the empty row."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter each contact method');
    expect(screen.getByLabelText('Contact 1')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Contact 2')).toHaveAttribute('aria-invalid', 'true');
  });
});

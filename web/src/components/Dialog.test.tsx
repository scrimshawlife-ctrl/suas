import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel this request?">
        <button>Keep</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('traps focus, closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Cancel this request?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = screen.getByRole('button', { name: 'Close' });
    const keep = screen.getByRole('button', { name: 'Keep' });
    expect(close).toHaveFocus();

    await user.tab();
    expect(keep).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(keep).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('focuses the initialFocusRef control on open', async () => {
    function SafeChoice() {
      const [open, setOpen] = useState(false);
      const keepRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Cancel this request?"
            initialFocusRef={keepRef}
          >
            <button ref={keepRef}>Keep request active</button>
            <button>Cancel request</button>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<SafeChoice />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Keep request active' })).toHaveFocus();
  });
});

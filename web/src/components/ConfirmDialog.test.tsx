import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function renderDialog(props: { pending: boolean; error?: string }) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Publish this draft?"
      confirmLabel="Publish"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    >
      <p>It goes live at once.</p>
    </ConfirmDialog>,
  );
  return {
    onConfirm,
    onClose,
    dialog: screen.getByRole('dialog', { name: 'Publish this draft?' }),
  };
}

describe('ConfirmDialog', () => {
  it('while a retry is pending, keeps the last error and cannot be confirmed or closed', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose, dialog } = renderDialog({
      pending: true,
      error: 'That did not go through. Try again.',
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'That did not go through. Try again.',
    );
    const working = within(dialog).getByRole('button', { name: 'Working…' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(working).toHaveAttribute('aria-disabled', 'true');
    expect(cancel).toHaveAttribute('aria-disabled', 'true');

    await user.click(working);
    await user.click(cancel);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('once settled with an error, shows it and lets the person retry or close', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose, dialog } = renderDialog({
      pending: false,
      error: 'That did not go through. Try again.',
    });
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await user.keyboard('{Escape}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog, and Enter or Space on a button acts on it', async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose, dialog } = renderDialog({ pending: false });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const publish = within(dialog).getByRole('button', { name: 'Publish' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(publish).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();

    await user.keyboard(' ');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows no alert without an error', () => {
    const { dialog } = renderDialog({ pending: false });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

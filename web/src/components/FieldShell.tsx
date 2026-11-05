import type { ReactNode } from 'react';
import { useId } from 'react';
import { AlertCircleIcon } from './icons';

export interface FieldShellProps {
  label: string;
  helper?: string;
  error?: string;
  id?: string;
  /** Receives the control id, `aria-describedby` and `aria-invalid` to spread on the control. */
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => ReactNode;
}

/**
 * Label, helper and error text around a form control. The error is ink with an alert icon
 * and a 3 px control border (see `fieldClass`), never red.
 */
export function FieldShell({ label, helper, error, id, children }: FieldShellProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const helperId = helper ? `${controlId}-helper` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={controlId} className="text-17 font-bold">
        {label}
      </label>
      {children({
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {helper ? (
        <p id={helperId} className="text-16 text-slate">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-center gap-2 text-16 font-bold">
          <AlertCircleIcon size={20} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Shared control look: 56 px, 2 px slate border, 20 px text; ink 3 px border when invalid. */
export const fieldClass =
  'w-full min-h-14 rounded-8 border-2 border-slate bg-white px-4 py-3 text-20 text-ink focus:border-service-blue aria-invalid:border-[3px] aria-invalid:border-ink';

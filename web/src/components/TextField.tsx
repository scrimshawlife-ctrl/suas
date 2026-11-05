import type { InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FieldShell, fieldClass } from './FieldShell';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helper?: string;
  /** Plain-words error. Setting it switches the field to the ink error state. */
  error?: string;
}

export function TextField({ label, helper, error, id, className, ...input }: TextFieldProps) {
  return (
    <FieldShell label={label} helper={helper} error={error} id={id}>
      {(control) => <input className={cn(fieldClass, className)} {...control} {...input} />}
    </FieldShell>
  );
}

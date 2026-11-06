import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FieldShell, fieldClass } from './FieldShell';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  helper?: string;
  error?: string;
}

export function TextArea({
  label,
  helper,
  error,
  id,
  className,
  rows = 4,
  ...textarea
}: TextAreaProps) {
  return (
    <FieldShell label={label} helper={helper} error={error} id={id}>
      {(control) => (
        <textarea
          rows={rows}
          className={cn(fieldClass, 'resize-y', className)}
          {...control}
          {...textarea}
        />
      )}
    </FieldShell>
  );
}

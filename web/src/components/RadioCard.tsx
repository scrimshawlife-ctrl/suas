import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

export interface RadioCardProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'title'
> {
  title: ReactNode;
  description?: ReactNode;
}

/**
 * One choice. The whole card is the click target. Selected = 2 px ink border plus a 1 px
 * inset line, so the state never relies on colour.
 */
export function RadioCard({ title, description, id, ...input }: RadioCardProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <label
      htmlFor={inputId}
      className="flex min-h-16 cursor-pointer items-start gap-4 rounded-12 border-2 border-line bg-white px-5.5 py-5 hover:border-slate has-checked:border-ink has-checked:shadow-[inset_0_0_0_1px_#101828]"
    >
      <input
        id={inputId}
        type="radio"
        className="mt-0.5 size-6.5 shrink-0 accent-service-blue"
        {...input}
      />
      <span className="flex flex-col gap-1">
        <span className="text-20 font-bold">{title}</span>
        {description ? <span className="text-slate">{description}</span> : null}
      </span>
    </label>
  );
}

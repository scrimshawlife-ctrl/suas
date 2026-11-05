import { useEffect, useRef, type RefObject } from 'react';

/**
 * After a failed submit, moves focus to the first control marked `aria-invalid`, so a screen
 * reader announces the error. `signal` must change whenever the errors or a new attempt do
 * (for example `${attempt}|${message}`); the effect then runs after the error is rendered.
 */
export function useFocusFirstInvalid(form: RefObject<HTMLElement | null>, signal: string): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [form, signal]);
}

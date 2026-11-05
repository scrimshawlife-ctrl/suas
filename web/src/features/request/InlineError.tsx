import { AlertCircleIcon } from '../../components/icons';

/** A failed action in plain words: ink, an icon and a sentence. Never red. */
export function InlineError({ children }: { children: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-16 font-bold">
      <AlertCircleIcon size={20} className="mt-0.5 shrink-0" />
      {children}
    </p>
  );
}

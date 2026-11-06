import { useId } from 'react';
import { Link } from 'react-router';
import { Button } from './Button';

export interface CrisisPanelProps {
  /**
   * `compact` is the Home / request panel: safety footnote and "More crisis options" link.
   * `full` is the Crisis page panel: the "not an emergency service" line sits in the body
   * and the panel ends with a button back to SUAS support.
   */
  layout?: 'compact' | 'full';
  /** Target of "Continue with SUAS support" (full layout). */
  continueTo?: string;
}

/** The Harbor "Need help right now?" panel. D-012 wording, verbatim; 911 and 988 in SOS red. */
export function CrisisPanel({ layout = 'compact', continueTo = '/home' }: CrisisPanelProps) {
  const headingId = useId();
  const full = layout === 'full';
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3.5 rounded-12 bg-harbor p-7.5 text-white max-sm:p-5.5 max-sm:text-16"
    >
      <h2 id={headingId} className="heading text-30 max-sm:text-24">
        Need help right now?
      </h2>
      <p>
        If you are in immediate danger, have a medical emergency, or believe someone may be
        seriously harmed, <strong>call 911 or go to the nearest emergency department.</strong>
      </p>
      {full ? (
        <p>
          SUAS coordinates practical support. It is <strong>not an emergency service</strong> and
          cannot replace police, fire, EMS, or emergency medical care.
        </p>
      ) : null}
      <p>
        If you are experiencing suicidal thoughts, severe emotional distress, or a mental health
        crisis, call or text the <strong>988 Suicide &amp; Crisis Lifeline at 988</strong>.
      </p>
      <div className="mt-1.5 flex flex-col gap-2.5">
        <Button variant="sos" href="tel:911">
          Call 911
        </Button>
        <Button variant="sos" href="tel:988">
          Call or text 988
        </Button>
        {full ? (
          <Button variant="onHarborOutline" href={continueTo}>
            Continue with SUAS support
          </Button>
        ) : null}
      </div>
      {full ? null : (
        <>
          <p className="text-16 text-harbor-tint">
            SUAS coordinates practical support. It is not an emergency service and cannot replace
            police, fire, EMS, or emergency medical care.
          </p>
          <Link
            to="/crisis"
            className="inline-flex min-h-11 items-center self-start text-16 font-bold text-white hover:text-harbor-tint"
          >
            More crisis options
          </Link>
        </>
      )}
    </section>
  );
}

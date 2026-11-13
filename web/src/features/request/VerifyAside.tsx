import { Card } from '../../components/Card';

/**
 * The Verify pages' "Immediate danger?" side card, on every state of /verify and /verify/licence
 * (VA_CONFIRMATION_FLOW W10, SCRY_LICENCE_FALLBACK L10). Moved here unchanged from VerifyPage.
 */
export function VerifyCrisisCard() {
  return (
    <Card aria-labelledby="now" className="flex flex-col gap-3 border-ink bg-harbor text-white">
      <h2 id="now" className="text-20 font-bold">
        Immediate danger?{' '}
        <a
          href="tel:911"
          aria-label="Call 911"
          className="inline-flex min-h-11 min-w-11 items-center px-1 text-white"
        >
          Call 911
        </a>
        .
      </h2>
      <p>
        For suicide or emotional crisis support,{' '}
        <a
          href="tel:988"
          aria-label="Call 988"
          className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
        >
          call
        </a>{' '}
        or{' '}
        <a
          href="sms:988"
          aria-label="Text 988"
          className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
        >
          text 988
        </a>
        .
      </p>
      <p className="font-bold">
        Veterans Crisis Line:{' '}
        <a
          href="sms:838255"
          aria-label="Veterans Crisis Line: Text 838255"
          className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
        >
          Text 838255
        </a>
        .
      </p>
      <p className="text-harbor-tint">
        SUAS provides practical support coordination and is not an emergency-response service.
      </p>
    </Card>
  );
}

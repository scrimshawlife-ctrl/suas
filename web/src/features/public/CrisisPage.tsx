import { useState, type ReactNode } from 'react';
import { useSessionToken } from '../../api/token-store';
import { useMode } from '../../app/mode-store';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CrisisPanel } from '../../components/CrisisPanel';
import { Page } from '../../components/Page';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import {
  crisisResult,
  TRIAGE_OPTIONS,
  type CrisisButton,
  type TriageAnswer,
} from './crisis-result';

/** Bolds the bare "988" the way the board does. */
function withBold988(text: string): ReactNode {
  const parts = text.split('988');
  return parts.flatMap((part, index) =>
    index === 0 ? [part] : [<strong key={index}>988</strong>, part],
  );
}

function isAnswer(value: string): value is TriageAnswer {
  return TRIAGE_OPTIONS.some((option) => option.value === value);
}

/** Immediate resources (Crisis board). Open to everyone; the answer is never stored. */
export default function CrisisPage() {
  const signedIn = useSessionToken() !== null;
  const mode = useMode();
  const [answer, setAnswer] = useState<TriageAnswer>('unsure');
  const result = crisisResult(answer);

  // Signed out, "Continue with SUAS" starts at sign in; signed in it returns to the mode's home.
  const continueTo = !signedIn ? '/sign-in' : mode === 'serve' ? '/serve' : '/home';
  const backLabel = !signedIn
    ? 'Back to home'
    : mode === 'serve'
      ? 'Back to Serve'
      : 'Back to Support';
  const backTo = signedIn ? continueTo : '/';

  const buttons: Record<CrisisButton, ReactNode> = {
    call911: (
      <Button key="911" variant="sos" href="tel:911" className="max-sm:w-full">
        Call 911
      </Button>
    ),
    call988: (
      <Button key="988" variant="sos" href="tel:988" className="max-sm:w-full">
        Call or text 988
      </Button>
    ),
    text838255: (
      <Button
        key="838255"
        variant="sos"
        href="sms:838255"
        aria-label="Veterans Crisis Line: Text 838255"
        className="max-sm:w-full"
      >
        Text 838255
      </Button>
    ),
    continue: (
      <Button key="continue" variant="secondary" href={continueTo} className="max-sm:w-full">
        Continue with SUAS
      </Button>
    ),
  };

  return (
    <Page className="pt-10 pb-18">
      <title>Immediate resources · SUAS</title>
      <BackLink to={backTo}>{backLabel}</BackLink>
      <h1 className="heading text-52 max-sm:text-40">Immediate resources</h1>

      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-start gap-6 max-[960px]:grid-cols-1">
        <div className="flex flex-col gap-5">
          <Card padding="none" className="p-8 max-sm:p-5">
            <RadioCardGroup
              legend={<span className="heading text-32">Is anyone in immediate danger?</span>}
              hint="Choose the answer that best describes the situation."
              name="triage"
              options={TRIAGE_OPTIONS}
              value={answer}
              onValueChange={(value) => isAnswer(value) && setAnswer(value)}
            />
          </Card>

          <Card
            aria-labelledby="triage-result"
            role="status"
            emphasis
            padding="none"
            className="flex flex-col gap-3.5 p-8 max-sm:p-5"
          >
            <h2 id="triage-result" className="heading text-28">
              {result.heading}
            </h2>
            {result.paragraphs.map((paragraph) => (
              <p key={paragraph}>{withBold988(paragraph)}</p>
            ))}
            <div className="mt-1.5 flex flex-wrap gap-3">
              {result.buttons.map((button) => buttons[button])}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <CrisisPanel layout="full" continueTo={continueTo} />
          <Card aria-labelledby="alone" padding="none" className="flex flex-col gap-3 p-7">
            <h2 id="alone" className="text-22 font-bold">
              You do not have to handle this alone.
            </h2>
            <p>
              If you are a Veteran in crisis or concerned about a Veteran, call or text{' '}
              <strong>988</strong> for immediate crisis support.
            </p>
            <p className="text-slate">
              SUAS can still help coordinate practical needs such as transportation, temporary
              lodging, food, and connection to participating organizations when those services are
              available.
            </p>
            <div className="mt-1 flex flex-wrap gap-2.5">
              <Button variant="sos" href="tel:988" className="max-sm:w-full">
                Contact crisis support
              </Button>
              <Button
                variant="sos"
                href="sms:838255"
                aria-label="Veterans Crisis Line: Text 838255"
                className="max-sm:w-full"
              >
                Text 838255
              </Button>
              <Button
                variant="secondary"
                href={signedIn ? '/home' : '/sign-in?role=need'}
                className="max-sm:w-full"
              >
                Request practical support
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}

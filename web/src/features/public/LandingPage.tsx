import { Link } from 'react-router';
import { useSessionToken } from '../../api/token-store';
import { Page } from '../../components/Page';
import { ArrowRightIcon } from '../../components/icons';

const steps = [
  {
    title: 'Sign in with your email',
    body: 'We send a 6-digit code. No password to remember.',
  },
  {
    title: 'Confirm you served',
    body: 'Asking for help needs a quick ID check. Anyone signed in can help.',
  },
  { title: 'Ask, or pick one up', body: 'Food, rides, temporary shelter and peer support.' },
  { title: 'Talk it through', body: 'Once a veteran takes your request, you can chat.' },
];

interface ChoiceProps {
  to: string;
  title: string;
  body: string;
  cta: string;
  tone: 'need' | 'serve';
}

function Choice({ to, title, body, cta, tone }: ChoiceProps) {
  return (
    <Link
      to={to}
      className={`group flex min-h-[300px] flex-col justify-between gap-10 rounded-6 px-9 pt-9 pb-8 text-white no-underline hover:text-white max-sm:min-h-60 max-sm:p-7 ${
        tone === 'need' ? 'bg-service-blue' : 'bg-harbor'
      }`}
    >
      <span className="flex flex-col gap-3.5">
        <span className="heading text-56 max-sm:text-40">{title}</span>
        <span className="max-w-[30ch] text-20">{body}</span>
      </span>
      <span className="inline-flex items-center gap-3 text-20 font-bold">
        <span className="grid size-13 place-items-center rounded-full border-2 border-current group-hover:border-white group-hover:bg-white group-hover:text-ink">
          <ArrowRightIcon />
        </span>
        {cta}
      </span>
    </Link>
  );
}

/** Landing (Main board). Signed-in visitors see the same page with the cards going to their homes. */
export default function LandingPage() {
  const signedIn = useSessionToken() !== null;
  return (
    <Page className="gap-14 pt-18 pb-20 max-sm:pt-10">
      <title>SUAS · Veterans helping veterans</title>
      <div className="flex flex-wrap items-center justify-between gap-10">
        <div className="flex max-w-[760px] flex-[1_1_520px] flex-col gap-5">
          <h1 className="heading max-w-[11ch] text-96 leading-[0.98] tracking-[-0.025em] max-sm:text-60">
            Veterans helping veterans.
          </h1>
          <p className="max-w-[34ch] text-24 leading-[1.4] text-slate">
            Veteran peer support, coordinated by people who served.
          </p>
        </div>
        <img src="/suas-mark-color.svg" alt="" className="size-60 flex-none max-sm:size-33" />
      </div>

      <section aria-labelledby="take-action" className="flex flex-col gap-5">
        <h2 id="take-action" className="heading text-30">
          Take action
        </h2>
        <div className="grid grid-cols-2 gap-5 max-sm:grid-cols-1">
          <Choice
            tone="need"
            to={signedIn ? '/home' : '/sign-in?role=need'}
            title="I need support"
            body="Food, a ride, a safe place tonight, or someone who served to talk to."
            cta="Ask for support"
          />
          <Choice
            tone="serve"
            to={signedIn ? '/serve' : '/sign-in?role=serve'}
            title="I want to serve"
            body="Pick up a request from a fellow veteran and see it through."
            cta="Start serving"
          />
        </div>
      </section>

      <section aria-labelledby="how" className="flex flex-col gap-6">
        <h2 id="how" className="heading text-30">
          How it works
        </h2>
        <ol className="grid grid-cols-4 gap-6 max-[900px]:grid-cols-2 max-sm:grid-cols-1">
          {steps.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2.5 border-t-[3px] border-ink pt-5">
              <span className="heading text-40">{index + 1}</span>
              <span className="text-20 font-bold">{step.title}</span>
              <span className="text-slate">{step.body}</span>
            </li>
          ))}
        </ol>
      </section>
    </Page>
  );
}

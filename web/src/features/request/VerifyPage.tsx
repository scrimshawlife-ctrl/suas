import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { Stepper } from '../../components/Stepper';
import { AlertCircleIcon, CheckIcon, LockIcon } from '../../components/icons';
import { useIdVerification, useStartIdVerification } from '../public/api';
import { safeFrom } from '../public/signin-flow';
import {
  isOtherStartError,
  verifyStep,
  verifyView,
  type VerifyView,
} from '../public/verify-status';

const STEPS = ['Scan your ID', 'Take a quick selfie', "You're in"] as const;

function Notice({ children }: { children: string }) {
  return (
    <p className="flex items-start gap-2.5 font-bold">
      <AlertCircleIcon className="mt-0.5" />
      {children}
    </p>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 id="check" tabIndex={-1} className="heading text-30">
      {children}
    </h2>
  );
}

/** The action card: what the person can do now, by status. */
function StatusCard({
  view,
  starting,
  onStart,
  continueTo,
  startFailed,
}: {
  view: VerifyView;
  starting: boolean;
  onStart: () => void;
  continueTo: string;
  startFailed: boolean;
}) {
  const startButton = (label: string) => (
    <div>
      <Button size="form" onClick={onStart} disabled={starting}>
        {starting ? 'Starting' : label}
      </Button>
    </div>
  );
  const helpOthers = (
    <div className="flex flex-col gap-2 border-t border-line pt-5">
      <h3 className="text-20 font-bold">You can still help others</h3>
      <p className="text-slate">Helping does not need the ID check.</p>
      <div>
        <Button variant="secondary" href="/serve">
          Go to Serve
        </Button>
      </div>
    </div>
  );

  // The button that was pressed leaves with the old view; keep focus in the card, on its new
  // heading, instead of dropping it to the top of the page.
  const live = useRef<HTMLDivElement>(null);
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const active = document.activeElement;
    if (active === null || active === document.body || live.current?.contains(active)) {
      live.current?.querySelector<HTMLElement>('#check')?.focus();
    }
  }, [view]);

  return (
    <Card padding="lg" aria-labelledby="check" className="flex flex-col gap-5">
      <div ref={live} aria-live="polite" className="flex flex-col gap-5">
        {view === 'start' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Heading>Check your ID</Heading>
              <p className="text-slate">
                A Veteran ID Card, or a driver's license with the Veteran designation, plus a quick
                selfie.
              </p>
            </div>
            {startFailed ? <Notice>We could not start the check. Try again.</Notice> : null}
            {startButton('Start verification')}
          </>
        ) : null}

        {view === 'pending' ? (
          <div className="flex flex-col gap-1.5">
            <Heading>Checking now</Heading>
            <p role="status" className="text-slate">
              Your check is in progress. This page updates by itself, so you can keep it open.
            </p>
          </div>
        ) : null}

        {view === 'verified' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Heading>
                <span className="flex items-center gap-2.5">
                  <CheckIcon size={28} />
                  You're confirmed
                </span>
              </Heading>
              <p className="text-slate">Thank you. You can ask for help now.</p>
            </div>
            <div>
              <Button size="form" href={continueTo}>
                Continue
              </Button>
            </div>
          </>
        ) : null}

        {view === 'not_confirmed' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Heading>We could not confirm your ID</Heading>
              <p className="text-slate">
                This can happen with glare or a blurry photo. You can start the check again.
              </p>
            </div>
            {startFailed ? <Notice>We could not start the check. Try again.</Notice> : null}
            {startButton('Try again')}
            {helpOthers}
          </>
        ) : null}

        {view === 'unavailable' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Heading>ID checks are not available right now</Heading>
              <p className="text-slate">
                We cannot run the check at the moment. Nothing is wrong with your account. Try again
                later.
              </p>
            </div>
            {startButton('Try again')}
            {helpOthers}
          </>
        ) : null}

        {view === 'revoked' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Heading>Your ID check is no longer valid</Heading>
              <p className="text-slate">You can still help others.</p>
            </div>
            {helpOthers}
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** Verify (Verify board, no camera): start the ID check, then follow its status. */
export default function VerifyPage() {
  const location = useLocation();
  const continueTo = safeFrom((location.state as { from?: unknown } | null)?.from) ?? '/home';
  const status = useIdVerification();
  const start = useStartIdVerification();

  // The status route is the source of truth; a failed start can only add "unavailable".
  const view = verifyView(status.data?.status, start.error);
  const startFailed = start.isError && isOtherStartError(start.error);

  return (
    <Page className="gap-7 pt-12 pb-18">
      <title>Confirm you served · SUAS</title>
      <div className="flex max-w-[760px] flex-col gap-2.5">
        <h1 className="heading text-56 max-sm:text-40">Confirm you served</h1>
        <p className="text-20 text-slate">
          Asking for help needs a quick ID check. It keeps requests coming from real veterans.
        </p>
      </div>

      <Stepper steps={STEPS} current={verifyStep(view)} label="Verification steps" />

      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-6 max-[860px]:grid-cols-1">
        {status.isPending ? (
          <Card padding="lg">
            <p role="status" className="text-slate">
              Loading…
            </p>
          </Card>
        ) : status.isError && status.data === undefined ? (
          <Card padding="lg" className="flex flex-col gap-4">
            <Notice>We could not load your check status.</Notice>
            <div>
              <Button variant="secondary" onClick={() => void status.refetch()}>
                Try again
              </Button>
            </div>
          </Card>
        ) : (
          <StatusCard
            view={view}
            starting={start.isPending}
            onStart={() => start.mutate()}
            continueTo={continueTo}
            startFailed={startFailed}
          />
        )}

        <aside className="flex flex-col gap-4">
          <Card aria-labelledby="keep" className="flex flex-col gap-3">
            <h2 id="keep" className="flex items-center gap-2.5 text-20 font-bold">
              <LockIcon />
              What we keep
            </h2>
            <p>Only the result: verified or not, when, and how it was checked.</p>
            <p>
              Your card photo and selfie are deleted right after the check. They are never shown to
              other veterans.
            </p>
          </Card>
          <Card aria-labelledby="why" className="flex flex-col gap-3">
            <h2 id="why" className="text-20 font-bold">
              Why a selfie too?
            </h2>
            <p>It shows the card belongs to you, so nobody can sign up with someone else's ID.</p>
          </Card>
          <Card
            aria-labelledby="now"
            className="flex flex-col gap-3 border-ink bg-harbor text-white"
          >
            <h2 id="now" className="text-20 font-bold">
              Immediate danger? Call{' '}
              <a href="tel:911" className="text-white">
                911
              </a>
              .
            </h2>
            <p>
              For suicide or emotional crisis support, call or text{' '}
              <a href="tel:988" className="font-bold text-white">
                988
              </a>
              .
            </p>
            <p className="text-harbor-tint">
              SUAS provides practical support coordination and is not an emergency-response service.
            </p>
          </Card>
        </aside>
      </div>
    </Page>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { isApiError } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { AlertCircleIcon, LockIcon } from '../../components/icons';
import { useSingleFlight } from '../../lib/single-flight';
import { useIdVerification } from '../public/api';
import { retryAtText } from '../public/verify-status';
import { VerifyCrisisCard } from '../request/VerifyAside';
import { HelpOthers, SelfAttestButton } from '../request/VerifyViews';
import { useLicenceReview, useSubmitLicence } from './api';
import { LicenceForm, type LicencePhotos } from './LicenceForm';
import { LicenceMessage } from './LicenceMessage';
import { LicenceNotice } from './LicenceNotice';
import { licenceView, type LicenceRefusal } from './licence-status';
import type { GrabFrame, OpenCamera } from './SelfieCamera';

/** These say the offer or the open review changed under the page; a fresh read shows which. */
const REREAD_CODES = new Set([
  'LICENCE_REVIEW_NOT_OFFERED',
  'LICENCE_REVIEW_OPEN',
  'LICENCE_REVIEW_NOT_DISPUTABLE',
]);

/** Refusals that replace the whole view (L4.6, L8.3, R9.1 W7). */
const REFUSAL_VIEWS: Readonly<Record<string, LicenceRefusal>> = {
  LICENCE_SUBMISSION_LIMIT: 'limit',
  ID_VERIFICATION_UNAVAILABLE: 'closed',
  VERIFICATION_REVOKED: 'revoked',
};

/** Plain words for a send failure that stays on the form. Codes are never shown. */
function sendErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'LICENCE_NOTICE_VERSION_REQUIRED') {
      return 'This page is out of date. Reload it, read the notice again, then send.';
    }
    if (error.status === 400 || error.status === 413) {
      return 'We could not use these photos. Take them again and send them.';
    }
  }
  return 'We could not send your photos. Check your connection and try again.';
}

function limitText(seconds: number | null): string {
  if (seconds === null) return 'You can send your licence again later.';
  return `You can send your licence again after ${retryAtText(seconds)}.`;
}

export interface LicencePageProps {
  /** Camera seams for tests; jsdom has no camera or image decoder. */
  prepare?: (file: File) => Promise<Blob>;
  openCamera?: OpenCamera;
  grabFrame?: GrabFrame;
}

/**
 * The licence review page (suas-specs #73 R10.1 proposal, L2 to L8): the notice and three
 * captures, then the review followed to an admin's decision. The crisis strip and footer come
 * from the layout; the crisis card sits beside every state (L10).
 */
export default function LicencePage({ prepare, openCamera, grabFrame }: LicencePageProps = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const standing = useIdVerification();
  const licence = useLicenceReview();
  const submit = useSubmitLicence();
  const flight = useSingleFlight();
  const [refused, setRefused] = useState<{ view: LicenceRefusal; seconds: number | null } | null>(
    null,
  );
  const [replacing, setReplacing] = useState<{ id: string; dispute: boolean } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const review = licence.data?.review ?? null;
  const loaded = standing.data !== undefined && licence.data !== undefined;
  const view = loaded
    ? licenceView({
        standing: standing.data,
        offered: licence.data.offered || replacing?.dispute === true,
        review,
        refused: refused?.view ?? null,
        replacing: replacing?.id ?? null,
      })
    : null;
  const disputing = view === 'form' && replacing?.dispute === true;

  // The request guard reads the standing; an approval must reach it before Continue.
  useEffect(() => {
    if (view === 'approved') void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [view, queryClient]);

  // Same as Verify: when the view changes, focus its heading unless focus is elsewhere on purpose.
  const card = useRef<HTMLDivElement>(null);
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current === view) return;
    const first = shown.current === null;
    shown.current = view;
    if (first) return;
    const active = document.activeElement;
    if (active === null || active === document.body || card.current?.contains(active)) {
      card.current?.querySelector<HTMLElement>('#check')?.focus();
    }
  }, [view]);

  const send = (photos: LicencePhotos) =>
    flight(async () => {
      setSendError(null);
      try {
        await submit.mutateAsync({
          photos,
          disputeOf: replacing?.dispute === true ? replacing.id : null,
        });
        setReplacing(null);
      } catch (error) {
        const refusal = isApiError(error) ? REFUSAL_VIEWS[error.code] : undefined;
        if (refusal !== undefined && isApiError(error)) {
          setRefused({ view: refusal, seconds: error.retryAfterSeconds });
        } else if (isApiError(error) && REREAD_CODES.has(error.code)) {
          setReplacing(null);
        } else {
          setSendError(sendErrorText(error));
        }
      } finally {
        // Drops the photos from the mutation cache.
        submit.reset();
      }
    });

  const resend = () => {
    setSendError(null);
    setRefused(null);
    if (review !== null) setReplacing({ id: review.review_id, dispute: false });
  };
  const dispute = () => {
    setSendError(null);
    if (review !== null) setReplacing({ id: review.review_id, dispute: true });
  };
  // Self-attestation lives on Verify; it opens there on the "Tell us you served" step.
  const selfAttest = () =>
    void navigate(paths.verify, { state: { choice: 'self_attest', from: paths.request } });

  if (view === 'not_offered') return <Navigate to={paths.verify} replace />;

  return (
    <Page className="gap-7 pt-12 pb-18">
      <title>Confirm with your licence · SUAS</title>
      <BackLink to={paths.verify}>Back to Confirm you served</BackLink>
      <div className="flex max-w-[760px] flex-col gap-2.5">
        <h1 className="heading text-56 max-sm:text-40">Confirm with your licence</h1>
        <p className="text-20 text-slate">
          Anyone signed in can help. To ask for help, confirm with VA, with your licence, or tell us
          you served.
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-6 max-[860px]:grid-cols-1">
        {view === null && (standing.isError || licence.isError) ? (
          <Card padding="lg" className="flex flex-col gap-4">
            <p className="flex items-start gap-2.5 font-bold">
              <AlertCircleIcon className="mt-0.5" />
              We could not load your check status.
            </p>
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  void standing.refetch();
                  void licence.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          </Card>
        ) : view === null ? (
          <Card padding="lg">
            <p role="status" className="text-slate">
              Loading…
            </p>
          </Card>
        ) : (
          <Card padding="lg" aria-labelledby="check">
            <div ref={card} className="flex flex-col gap-6">
              {/* Stays mounted; its content changes with each state, so the change is announced. */}
              <div aria-live="polite">
                <div key={`${view}|${String(disputing)}`} className="flex flex-col gap-5">
                  <LicenceMessage
                    view={view}
                    disputing={disputing}
                    declineReason={review?.decline_reason ?? null}
                    disputable={review?.disputable === true}
                    offered={licence.data?.offered === true}
                    retryAfter={limitText(refused?.seconds ?? null)}
                    continueTo={paths.request}
                    onResend={resend}
                    onDispute={dispute}
                    onSelfAttest={selfAttest}
                  />
                </div>
              </div>
              {view === 'form' ? (
                <>
                  <LicenceNotice />
                  <LicenceForm
                    sending={submit.isPending}
                    sendError={sendError}
                    onSubmit={send}
                    alternative={<SelfAttestButton onChoose={selfAttest} />}
                    {...(prepare ? { prepare } : {})}
                    {...(openCamera ? { openCamera } : {})}
                    {...(grabFrame ? { grabFrame } : {})}
                  />
                </>
              ) : null}
              {view === 'approved' ? null : <HelpOthers />}
            </div>
          </Card>
        )}

        <aside className="flex flex-col gap-4">
          <Card aria-labelledby="keep" className="flex flex-col gap-3">
            <h2 id="keep" className="flex items-center gap-2.5 text-20 font-bold">
              <LockIcon />
              What SUAS keeps
            </h2>
            <p>
              Your photos, your selfie and what was read from them, only until an admin decides, or
              30 days at most. Then they are deleted.
            </p>
            <p>
              After that: the decision, which version of the notice you saw, and whether the licence
              matched the details you gave VA. If it is approved, also a keyed fingerprint of the
              licence's state and number, so one licence can't confirm two accounts.
            </p>
          </Card>
          <VerifyCrisisCard />
        </aside>
      </div>
    </Page>
  );
}

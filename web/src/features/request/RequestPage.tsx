import { useState } from 'react';
import { Navigate } from 'react-router';
import { LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Page } from '../../components/Page';
import { useIntakeStatus } from './api';
import { AssistantPanel } from './AssistantPanel';
import { gateRedirect } from './errors';
import { FALLBACK_NOTICE } from './IntakeTurnView';
import { PlainForm } from './PlainForm';

const SAFETY_NOTE = 'This sends a peer support request. It does not contact emergency services.';

/**
 * /request: the Intake Assistant when it is available, and the plain form always shown
 * under it (R5.15). Both end in the same submitted request and a move to its status page.
 */
export default function RequestPage() {
  const status = useIntakeStatus();
  const [assistantFailed, setAssistantFailed] = useState(false);
  const [typedText, setTypedText] = useState('');

  if (status.isPending) return <LoadingScreen />;
  const gate = status.isError ? gateRedirect(status.error) : undefined;
  if (gate) return <Navigate to={gate} replace />;

  // If the status cannot be read, the form still works: it needs no assistant.
  const assistantAvailable = status.data?.assistant_available === true;
  const showAssistant = assistantAvailable && !assistantFailed;

  return (
    <Page width="narrow" className="gap-6 pt-10">
      <title>Request help · SUAS</title>
      <BackLink to="/home">Back to home</BackLink>
      <div className="flex flex-col gap-3">
        <h1 className="heading text-44 max-sm:text-32">Request help</h1>
        <p className="text-slate">
          {showAssistant
            ? 'Tell us in your own words, or fill in the form. A veteran in your county can then choose to help.'
            : 'Fill in the form below. A veteran in your county can then choose to help.'}
        </p>
      </div>

      {assistantAvailable ? (
        <section aria-label="Intake Assistant" hidden={assistantFailed}>
          <AssistantPanel
            onFallback={(typed) => {
              setTypedText(typed);
              setAssistantFailed(true);
            }}
          />
        </section>
      ) : null}

      <section aria-label="Simple form" className="flex flex-col gap-4">
        {showAssistant ? <h2 className="heading text-26">Or fill in the form</h2> : null}
        {assistantFailed ? <p className="font-bold">{FALLBACK_NOTICE}</p> : null}
        <PlainForm key={typedText} initialSummary={typedText} />
      </section>

      {assistantAvailable ? null : (
        <p className="text-slate">
          The assistant is not available right now. The form works the same.
        </p>
      )}

      <p className="font-bold">{SAFETY_NOTE}</p>
    </Page>
  );
}

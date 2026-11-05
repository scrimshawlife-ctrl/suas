import { useState } from 'react';
import { Navigate } from 'react-router';
import { LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Page } from '../../components/Page';
import { useIntakeStatus } from './api';
import { AssistantPanel } from './AssistantPanel';
import { gateRedirect } from './errors';
import { FALLBACK_NOTICE } from './IntakeTurnView';
import { PlainForm } from './PlainForm';

const SAFETY_NOTE = 'This sends a peer support request. It does not contact emergency services.';

/**
 * /request: the Intake Assistant when it is available, and the plain form always one tap
 * away. Both end in the same submitted request and a move to its status page.
 */
export default function RequestPage() {
  const status = useIntakeStatus();
  const [useForm, setUseForm] = useState(false);
  const [assistantFailed, setAssistantFailed] = useState(false);

  if (status.isPending) return <LoadingScreen />;
  const gate = status.isError ? gateRedirect(status.error) : undefined;
  if (gate) return <Navigate to={gate} replace />;

  // If the status cannot be read, the form still works: it needs no assistant.
  const assistantAvailable = status.data?.assistant_available === true;
  const showForm = !assistantAvailable || useForm;

  return (
    <Page width="narrow" className="gap-6 pt-10">
      <title>Request help · SUAS</title>
      <BackLink to="/home">Back to home</BackLink>
      <div className="flex flex-col gap-3">
        <h1 className="heading text-44 max-sm:text-32">Request help</h1>
        <p className="text-slate">
          {showForm
            ? 'Fill in the form below. A veteran in your county can then choose to help.'
            : 'Tell us in your own words. You will check a draft before anything is sent.'}
        </p>
      </div>

      {assistantAvailable ? (
        <div hidden={showForm}>
          <AssistantPanel
            onFallback={() => {
              setAssistantFailed(true);
              setUseForm(true);
            }}
          />
        </div>
      ) : null}

      {showForm ? (
        <section aria-label="Simple form" className="flex flex-col gap-4">
          {assistantFailed ? <p className="font-bold">{FALLBACK_NOTICE}</p> : null}
          <PlainForm />
        </section>
      ) : null}

      {assistantAvailable ? (
        <div className="flex">
          <Button variant="secondary" size="small" onClick={() => setUseForm(!useForm)}>
            {showForm ? 'Describe it in your own words instead' : 'Use the simple form instead'}
          </Button>
        </div>
      ) : (
        <p className="text-slate">
          The assistant is not available right now. The form works the same.
        </p>
      )}

      <p className="font-bold">{SAFETY_NOTE}</p>
    </Page>
  );
}

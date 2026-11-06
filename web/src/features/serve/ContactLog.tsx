import { useState } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CheckIcon } from '../../components/icons';
import { useSaveContact } from './api';
import {
  CHANNEL_OPTIONS,
  OUTCOME_OPTIONS,
  contactSave,
  type ContactChannel,
  type ContactOutcome,
} from './case-logic';
import { PillGroup } from './Pill';

/** "Log a contact attempt": channel and outcome pills, saved through the route the outcome needs. */
export function ContactLog({ caseId }: { caseId: string }) {
  const [channel, setChannel] = useState<ContactChannel>('PHONE');
  const [outcome, setOutcome] = useState<ContactOutcome>('REACHED');
  const save = useSaveContact(caseId);

  return (
    <Card aria-labelledby="log" padding="lg" className="flex flex-col gap-5 max-sm:p-5">
      <h2 id="log" className="text-22 font-bold">
        Log a contact attempt
      </h2>
      <PillGroup
        legend="How did you reach out?"
        name="channel"
        options={CHANNEL_OPTIONS}
        value={channel}
        onChange={setChannel}
      />
      <PillGroup
        legend="What happened?"
        name="outcome"
        options={OUTCOME_OPTIONS}
        value={outcome}
        onChange={setOutcome}
      />
      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="secondary"
          disabled={save.isPending}
          onClick={() => save.mutate(contactSave(channel, outcome))}
        >
          {save.isPending ? 'Saving…' : 'Save contact attempt'}
        </Button>
        <p role="status" className="flex items-center gap-2 font-bold empty:sr-only">
          {save.isSuccess ? (
            <>
              <CheckIcon />
              Saved.
            </>
          ) : null}
          {save.isError ? "That didn't save. Try again." : null}
        </p>
      </div>
    </Card>
  );
}

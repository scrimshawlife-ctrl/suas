import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusChip, type StatusKind } from '../../components/StatusChip';
import { TextArea } from '../../components/TextArea';
import { TextField } from '../../components/TextField';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { useSingleFlight } from '../../lib/single-flight';
import {
  useConsentTemplates,
  useCreateConsentTemplate,
  usePublishConsentTemplate,
  type ConsentTemplateVersion,
} from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { QueryNotice } from './QueryNotice';

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY = 20_000;

const STATUS: Record<ConsentTemplateVersion['status'], { label: string; kind: StatusKind }> = {
  DRAFT: { label: 'Draft', kind: 'wait' },
  PUBLISHED: { label: 'Published', kind: 'ok' },
  SUPERSEDED: { label: 'Replaced', kind: 'off' },
};

const formatDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

function CreateForm() {
  const create = useCreateConsentTemplate();
  const flight = useSingleFlight();
  const [templateKey, setTemplateKey] = useState('');
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<{ key?: string; body?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, `${attempt}|${Object.keys(problem).join()}`);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const key = templateKey.trim();
    const text = body.trim();
    const next: { key?: string; body?: string } = {};
    if (!KEY_PATTERN.test(key) || key.length > 64)
      next.key = 'Use lowercase letters, numbers and single hyphens, up to 64 characters.';
    if (text === '') next.body = 'Enter the template text.';
    setProblem(next);
    setAttempt((count) => count + 1);
    if (next.key || next.body) return;
    flight(() =>
      create.mutateAsync({ template_key: key, body: text }, { onSuccess: () => setBody('') }),
    );
  }

  return (
    <Card as="section" aria-labelledby="new-version-title" padding="lg">
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <h2 id="new-version-title" className="text-22 font-bold">
          New version
        </h2>
        <TextField
          label="Template key"
          helper="For example red-alert-trusted-contact. A key you used before gets its next version."
          maxLength={64}
          autoComplete="off"
          value={templateKey}
          error={problem.key}
          onChange={(event) => setTemplateKey(event.target.value)}
        />
        <TextArea
          label="Template text"
          helper="What a person agrees to. On staging, say that it is a synthetic test template."
          rows={8}
          maxLength={MAX_BODY}
          value={body}
          error={problem.body}
          onChange={(event) => setBody(event.target.value)}
        />
        {create.isError ? (
          <p role="alert" className="font-bold">
            We could not save this version. Check the key and try again.
          </p>
        ) : null}
        <div role="status">
          {create.isSuccess ? (
            <p className="font-bold">
              Saved {create.data.version_key} as a draft. Publish it below when it is ready.
            </p>
          ) : null}
        </div>
        <div className="flex">
          <Button type="submit" size="form" disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Save as draft'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TemplateItem({
  template,
  onPublish,
}: {
  template: ConsentTemplateVersion;
  onPublish: (template: ConsentTemplateVersion) => void;
}) {
  const status = STATUS[template.status];
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-bold break-all">{template.version_key}</h3>
        <StatusChip kind={status.kind}>{status.label}</StatusChip>
        <span className="text-16 text-slate">
          {template.published_at
            ? `Published ${formatDate.format(new Date(template.published_at))}`
            : `Saved ${formatDate.format(new Date(template.created_at))}`}
        </span>
      </div>
      <p className="max-h-40 overflow-y-auto text-16 break-words whitespace-pre-wrap">
        {template.body ?? ''}
      </p>
      {template.status === 'DRAFT' ? (
        <div className="flex">
          <Button
            size="small"
            aria-label={`Publish ${template.version_key}`}
            onClick={() => onPublish(template)}
          >
            Publish
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Consent templates (R9.3, contributor proposal, specs #72; CONSENT.md §6). A SUAS admin with
 * MFA writes a version, then publishes it; the key's earlier version is replaced for new
 * consents, and both steps are audited.
 */
export default function AdminConsentTemplatesPage() {
  const templates = useConsentTemplates();
  const publish = usePublishConsentTemplate();
  const flight = useSingleFlight();
  const [confirming, setConfirming] = useState<ConsentTemplateVersion | null>(null);
  const list = templates.data ?? [];

  return (
    <>
      <title>Consent templates · SUAS Admin</title>
      <div className="flex flex-col gap-1">
        <h1 className="heading text-40 max-sm:text-32">Consent templates</h1>
        <p className="text-slate">
          Write a version, read it again, then publish it. New consents use the published version of
          each key.
        </p>
      </div>

      <CreateForm />

      <section aria-labelledby="versions-title" className="flex flex-col gap-3.5">
        <h2 id="versions-title" className="text-22 font-bold">
          Versions
        </h2>
        <Card as="div" padding="none" aria-busy={templates.isFetching}>
          {templates.isPending ? (
            <p role="status" className="p-4 text-slate">
              Loading…
            </p>
          ) : templates.isError ? (
            <div className="p-4">
              <QueryNotice
                error={templates.error}
                what="consent templates"
                onRetry={() => void templates.refetch()}
              />
            </div>
          ) : list.length === 0 ? (
            <p className="p-4 text-slate">No consent templates yet.</p>
          ) : (
            <ul>
              {list.map((template) => (
                <TemplateItem
                  key={template.version_key}
                  template={template}
                  onPublish={(chosen) => {
                    publish.reset();
                    setConfirming(chosen);
                  }}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>

      <ConfirmDialog
        open={confirming !== null}
        title={`Publish ${confirming?.version_key ?? ''}?`}
        confirmLabel="Publish"
        cancelLabel="Cancel"
        pending={publish.isPending}
        error={
          publish.isError
            ? 'This version could not be published. It may already be published.'
            : undefined
        }
        onConfirm={() => {
          if (confirming === null) return;
          flight(() =>
            publish.mutateAsync(confirming.version_key, { onSuccess: () => setConfirming(null) }),
          );
        }}
        onClose={() => setConfirming(null)}
      >
        <p>
          New consents will use this text. An earlier published version of the same key is replaced.
          People who already agreed keep the version they agreed to.
        </p>
      </ConfirmDialog>
    </>
  );
}

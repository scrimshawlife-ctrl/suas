import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { AlertCircleIcon } from '../../components/icons';
import { TextArea } from '../../components/TextArea';
import { TextField } from '../../components/TextField';
import { useExtractDrafts } from './api';
import { LIMITS, validateExtract, type ExtractErrors, type ResourceDraft } from './draft-form';

export const BUILDER_UNAVAILABLE_TEXT =
  'The catalog builder is not available right now, so no drafts can be created from a source.';
const EXTRACTION_FAILED_TEXT =
  'The catalog builder could not read this text. No drafts were created. Try again, or shorten the text.';

/** Plain words for a failed extraction; the server's own 5xx text is never shown. */
export function extractErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'CATALOG_BUILDER_UNAVAILABLE') return BUILDER_UNAVAILABLE_TEXT;
    if (error.code === 'CATALOG_EXTRACTION_FAILED') return EXTRACTION_FAILED_TEXT;
    if (error.status < 500) return error.message;
  }
  return 'We could not create drafts. Check your connection and try again.';
}

/** "Add from a source": pasted text plus the link it came from. Drafts are never public. */
export function ExtractForm({ builderAvailable }: { builderAvailable: boolean }) {
  const extract = useExtractDrafts();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [errors, setErrors] = useState<ExtractErrors>({});
  const [created, setCreated] = useState<ResourceDraft[] | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (extract.isPending) return;
    const found = validateExtract({ source_text: text, source_link: link });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setCreated(null);
    extract.mutate(
      { source_text: text.trim(), source_link: link.trim() },
      {
        onSuccess: (drafts) => {
          setCreated(drafts);
          // With nothing found, keep the text so the admin can adjust it and retry.
          if (drafts.length > 0) {
            setText('');
            setLink('');
          }
        },
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="extract-title" padding="md" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="extract-title" className="text-22 font-bold">
          Add from a source
        </h2>
        <p className="text-16 text-slate">
          Paste the text of a page or document and the link it came from. The builder makes drafts.
          Nothing is shown to veterans until you publish a draft.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <TextArea
          label="Source text"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          error={errors.source_text}
          helper={`${text.trim().length.toLocaleString('en-US')} of ${LIMITS.sourceText.toLocaleString('en-US')} characters`}
        />
        <TextField
          label="Source link"
          type="url"
          inputMode="url"
          autoComplete="off"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          error={errors.source_link}
          helper="The page you copied the text from. You check each draft against it before you publish."
        />
        {!builderAvailable ? (
          <p className="flex items-start gap-2 font-bold">
            <AlertCircleIcon className="mt-1 shrink-0" />
            {BUILDER_UNAVAILABLE_TEXT}
          </p>
        ) : null}
        {extract.isError ? (
          <p role="alert" className="flex items-start gap-2 font-bold">
            <AlertCircleIcon className="mt-1 shrink-0" />
            {extractErrorMessage(extract.error)}
          </p>
        ) : null}
        <div className="flex">
          <Button type="submit" size="form" disabled={extract.isPending || !builderAvailable}>
            {extract.isPending ? 'Creating drafts…' : 'Create drafts'}
          </Button>
        </div>
      </form>
      {created !== null ? (
        <div role="status" className="flex flex-col gap-2 rounded-8 border border-line bg-mist p-4">
          {created.length === 0 ? (
            <p className="font-bold">
              No resources were found in that text. No drafts were created.
            </p>
          ) : (
            <>
              <p className="font-bold">
                {created.length === 1 ? 'Created 1 draft.' : `Created ${created.length} drafts.`}{' '}
                Review each one against the source before you publish.
              </p>
              <ul className="flex flex-col gap-1">
                {created.map((draft) => (
                  <li key={draft.resource_draft_id}>
                    <Link
                      to={paths.adminDraft(draft.resource_draft_id)}
                      className="inline-flex min-h-11 items-center font-bold"
                    >
                      {draft.service_name}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

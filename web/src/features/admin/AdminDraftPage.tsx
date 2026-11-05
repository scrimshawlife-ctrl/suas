import { useState } from 'react';
import { useParams } from 'react-router';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { useResourceDraft } from './api';
import { DraftEditor, draftErrorMessage } from './DraftEditor';
import { DraftStatusChip } from './AdminDraftsPage';
import { isHttpUrl, type ResourceDraft } from './draft-form';
import { CATEGORY_LABELS, CONTACT_KIND_LABELS, countiesLabel } from './labels';
import { QueryNotice } from './QueryNotice';
import { isApiError } from '../../api/errors';

const formatDateTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function SourceLink({ link }: { link: string }) {
  if (!isHttpUrl(link)) return <span className="break-all">{link}</span>;
  return (
    <a href={link} target="_blank" rel="noopener noreferrer" className="break-all">
      {link}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ReadOnlyFields({ draft }: { draft: ResourceDraft }) {
  const kind = draft.contact_method_kind ? CONTACT_KIND_LABELS[draft.contact_method_kind] : null;
  const rows: [string, string][] = [
    ['Service name', draft.service_name],
    ['Category', CATEGORY_LABELS[draft.category]],
    ['Counties served', countiesLabel(draft.counties)],
    ['Eligibility', draft.eligibility ?? 'Not stated'],
    ['Hours', draft.hours ?? 'Not stated'],
    ['Contact method', draft.contact_method ?? 'Not stated'],
    ['Contact method kind', kind ?? 'No kind'],
    ['Referral method', draft.referral_method ?? 'Not stated'],
    ['Cost', draft.cost ?? 'Not stated'],
  ];
  return (
    <dl className="flex flex-col gap-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-17 font-bold">{label}</dt>
          <dd className="break-words whitespace-pre-wrap">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AdminDraftPage() {
  const { id = '' } = useParams();
  const query = useResourceDraft(id);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const draft = query.data;
  const backTo =
    draft !== undefined && draft.status !== 'DRAFT'
      ? `${paths.adminDrafts}?status=${draft.status}`
      : paths.adminDrafts;

  return (
    <>
      <title>{`${draft?.service_name ?? 'Resource draft'} · SUAS Admin`}</title>
      <BackLink to={backTo}>Back to resource drafts</BackLink>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="heading min-w-0 text-40 break-words max-sm:text-32">
          {draft?.service_name ?? 'Resource draft'}
        </h1>
        {draft !== undefined ? <DraftStatusChip status={draft.status} /> : null}
      </div>
      {draft === undefined && query.isPending ? (
        <p role="status" className="text-slate">
          Loading…
        </p>
      ) : draft === undefined ? (
        isApiError(query.error) && query.error.status === 404 ? (
          <p className="font-bold">{draftErrorMessage(query.error)}</p>
        ) : (
          <QueryNotice error={query.error} what="this draft" onRetry={() => void query.refetch()} />
        )
      ) : (
        <>
          <Card as="section" aria-label="Source" padding="sm" className="flex flex-col gap-1">
            <p className="text-17 font-bold">Source</p>
            <SourceLink link={draft.source_link} />
            <p className="text-16 text-slate">
              {draft.status === 'DRAFT'
                ? 'Check every field against this page before you publish.'
                : 'The page this draft was checked against.'}
            </p>
          </Card>
          <Card as="section" aria-label="Draft details" padding="lg" className="max-w-2xl">
            {draft.status === 'DRAFT' ? (
              <div className="flex flex-col gap-4">
                {savedAt !== null ? (
                  <p role="status" className="font-bold">
                    Changes saved.
                  </p>
                ) : null}
                <DraftEditor
                  key={draft.updated_at}
                  draft={draft}
                  onSaved={() => setSavedAt(new Date().toISOString())}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <p role="status" className="font-bold">
                  {draft.status === 'PUBLISHED'
                    ? 'Published as a verified Resource.'
                    : 'Discarded. This draft was not published.'}
                  {draft.reviewed_at
                    ? ` ${formatDateTime.format(new Date(draft.reviewed_at))}.`
                    : null}
                </p>
                <p className="text-16 text-slate">
                  Published and discarded drafts cannot be edited.
                </p>
                <ReadOnlyFields draft={draft} />
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

import { Card } from '../../components/Card';
import { StatusChip } from '../../components/StatusChip';
import { useAdapterCatalog, useBuildInfo, type AdapterCatalogEntry } from './api';
import { capabilityRows, readinessWords } from './capabilities';
import { capabilityWords, credentialWords, decisionWords, modeWords } from './adapters';
import { QueryNotice } from './QueryNotice';

const noteClass = 'text-16 text-slate';

function CapabilitiesCard() {
  const info = useBuildInfo();
  const rows =
    info.data !== undefined
      ? capabilityRows((info.data.capabilities ?? {}) as Record<string, string | number | boolean>)
      : [];
  return (
    <Card as="section" aria-labelledby="caps" padding="none">
      <h2 id="caps" className="px-4 pt-4.5 pb-1.5 text-19 font-bold">
        Capabilities
      </h2>
      {info.isPending ? (
        <p role="status" className="px-4 pb-4 text-slate">
          Loading…
        </p>
      ) : info.isError ? (
        <div className="px-4 pb-4">
          <QueryNotice error={info.error} what="capabilities" onRetry={() => void info.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-4 text-slate">This build did not report any capabilities.</p>
      ) : (
        <div>
          <p
            aria-hidden="true"
            className="grid grid-cols-[1fr_1fr_1.5fr] gap-x-4 border-b border-line px-4 py-2.5 text-16 font-bold text-slate max-sm:hidden"
          >
            <span>Capability</span>
            <span>Status</span>
            <span>Note</span>
          </p>
          <dl>
            {rows.map((row) => (
              <div
                key={row.name}
                className="grid grid-cols-[1fr_1fr_1.5fr] items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 text-16 last:border-b-0 max-sm:grid-cols-1 max-sm:items-start"
              >
                <dt className="max-sm:font-bold">{row.name}</dt>
                <dd className="m-0">
                  <StatusChip kind={row.kind}>{row.status}</StatusChip>
                </dd>
                <dd className="m-0 text-slate">{row.note}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Card>
  );
}

function AdapterCard({ adapter }: { adapter: AdapterCatalogEntry }) {
  return (
    <li>
      <Card as="div" padding="sm" className="flex h-full flex-col gap-2.5">
        <h3 className="text-18 font-bold">{adapter.label}</h3>
        <p className={noteClass}>
          {capabilityWords(adapter.capability)}. {modeWords(adapter.integration_mode)}.
        </p>
        <p className="text-16">Credentials: {credentialWords(adapter.secret_presence)}</p>
        <p className="text-16">{decisionWords(adapter.decision)}</p>
      </Card>
    </li>
  );
}

function AdaptersSection() {
  const catalog = useAdapterCatalog();
  return (
    <section aria-labelledby="prov" className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h2 id="prov" className="text-22 font-bold">
          Provider adapters
        </h2>
        <p className={noteClass}>
          These are the adapters this build can run. Turning a provider on or off, and setting its
          routing, is not available on this page yet.
        </p>
      </div>
      {catalog.isPending ? (
        <p role="status" className="text-slate">
          Loading…
        </p>
      ) : catalog.isError ? (
        <QueryNotice
          error={catalog.error}
          what="provider adapters"
          onRetry={() => void catalog.refetch()}
        />
      ) : catalog.data.length === 0 ? (
        <p className="text-slate">This build has no provider adapters.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
          {catalog.data.map((adapter) => (
            <AdapterCard key={`${adapter.adapter_id}:${adapter.capability}`} adapter={adapter} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReadinessChip() {
  const info = useBuildInfo();
  const value = info.data?.production_readiness;
  if (typeof value !== 'string') return null;
  return <StatusChip kind="warn">Production readiness: {readinessWords(value)}</StatusChip>;
}

function ReadinessCard() {
  const info = useBuildInfo();
  const capabilities = info.data?.capabilities as Record<string, unknown> | undefined;
  const effects = capabilities?.allow_real_external_effects;
  return (
    <Card as="section" aria-labelledby="ready" padding="sm" className="flex flex-col gap-2.5">
      <h2 id="ready" className="text-19 font-bold">
        Readiness
      </h2>
      <p className="text-16">
        SPEC-018 evidence is required before any production readiness claim.
        {effects === false ? ' Real-world effects are disabled.' : null}
        {effects === true ? ' Real-world effects are enabled in this environment.' : null}
      </p>
    </Card>
  );
}

export default function AdminOverviewPage() {
  return (
    <>
      <title>Overview · SUAS Admin</title>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-40 max-sm:text-32">Overview</h1>
        <ReadinessChip />
      </div>
      <CapabilitiesCard />
      <AdaptersSection />
      <ReadinessCard />
    </>
  );
}

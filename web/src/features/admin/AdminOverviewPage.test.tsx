import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import AdminOverviewPage from './AdminOverviewPage';
import { capabilityRows } from './capabilities';
import { renderPage } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const buildInfo = {
  production_readiness: 'NOT_READY',
  capabilities: {
    email_mode: 'fake',
    safety_copy_mode: 'approved',
    support_signal_mode: 'fixture',
    allow_real_external_effects: false,
  },
};

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
});

describe('overview', () => {
  it('builds capabilities and adapters only from the API', async () => {
    client.GET.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith('build-info')
          ? { data: buildInfo }
          : {
              data: {
                adapters: [
                  {
                    adapter_id: 'x-api',
                    capability: 'TRANSPORTATION',
                    integration_mode: 'API',
                    decision: 'D-017',
                    label: 'Whatever the API calls it',
                    secret_presence: 'MISSING',
                  },
                ],
              },
            },
      ),
    );
    renderPage(<AdminOverviewPage />);
    expect(await screen.findByText('Production readiness: not ready')).toBeInTheDocument();
    expect(await screen.findByText('Whatever the API calls it')).toBeInTheDocument();
    expect(screen.getByText('Credentials: missing')).toBeInTheDocument();
    expect(screen.getByText('Approved copy on')).toBeInTheDocument();
    expect(
      screen.getByText('Real-world effects are disabled.', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Uber|Amadeus/)).not.toBeInTheDocument();
    expect(screen.queryByText('Notifications delivery')).not.toBeInTheDocument();
  });

  it('shows no fake status when build info fails to load', async () => {
    client.GET.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'missing'));
    renderPage(<AdminOverviewPage />);
    expect(await screen.findAllByText(/We could not load/)).not.toHaveLength(0);
    expect(screen.queryByText(/Production readiness/)).not.toBeInTheDocument();
    expect(screen.queryByText('Approved copy on')).not.toBeInTheDocument();
  });
});

describe('capabilityRows', () => {
  it('leaves out a row whose value is not reported', () => {
    expect(capabilityRows({})).toEqual([]);
  });

  it('marks real email as configured only with its credentials', () => {
    const resend = {
      email_mode: 'resend',
      resend_api_key_configured: true,
      email_from_configured: true,
    };
    expect(capabilityRows(resend)[0]?.status).toBe('Configured');
    expect(capabilityRows({ ...resend, resend_api_key_configured: false })[0]?.status).toBe(
      'Not configured',
    );
  });
});

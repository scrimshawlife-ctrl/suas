import type { StatusKind } from '../../components/StatusChip';

export interface CapabilityRow {
  name: string;
  kind: StatusKind;
  status: string;
  note: string;
}

type Capabilities = Record<string, string | number | boolean>;

/**
 * Capability rows built only from what GET /admin/build-info reports. A row whose value is
 * missing from the response is left out rather than guessed. "Notifications delivery" on
 * the board is not a row: the same email mode already shows under Email sign-in.
 */
export function capabilityRows(capabilities: Capabilities): CapabilityRow[] {
  const rows: CapabilityRow[] = [];

  const email = capabilities.email_mode;
  if (typeof email === 'string') {
    if (email === 'fake' || email === 'sink') {
      rows.push({
        name: 'Email sign-in',
        kind: 'info',
        status: 'Test mode',
        note: 'No real email is sent in this mode',
      });
    } else if (email === 'disabled') {
      rows.push({ name: 'Email sign-in', kind: 'off', status: 'Off', note: 'Email is turned off' });
    } else {
      const ready = emailReady(email, capabilities);
      rows.push({
        name: 'Email sign-in',
        kind: ready ? 'ok' : 'off',
        status: ready ? 'Configured' : 'Not configured',
        note: ready ? `Provider: ${email}` : 'No credential present',
      });
    }
  }

  const safety = capabilities.safety_copy_mode;
  if (safety === 'approved') {
    rows.push({
      name: 'Crisis copy',
      kind: 'ok',
      status: 'Approved copy on',
      note: 'Wording from SAFETY_COPY (D-012, D-050)',
    });
  } else if (safety === 'placeholder_test_only') {
    rows.push({
      name: 'Crisis copy',
      kind: 'info',
      status: 'Test copy',
      note: 'Placeholder wording for testing only',
    });
  } else if (safety === 'disabled') {
    rows.push({
      name: 'Crisis copy',
      kind: 'off',
      status: 'Off',
      note: 'Crisis copy is turned off',
    });
  }

  const signal = capabilities.support_signal_mode;
  if (signal === 'fixture') {
    rows.push({
      name: 'Support Signal scoring',
      kind: 'info',
      status: 'Fixture',
      note: 'Not a clinical score',
    });
  } else if (signal === 'disabled') {
    rows.push({
      name: 'Support Signal scoring',
      kind: 'off',
      status: 'Off',
      note: 'Scoring is turned off',
    });
  }

  return rows;
}

/**
 * Whether a real email mode has what it needs to send, by the build-info flags. `gmail_smtp`
 * sends through its relay, or directly with the Gmail address and app password (R11.2).
 */
function emailReady(mode: string, capabilities: Capabilities): boolean {
  if (mode === 'resend') {
    return (
      capabilities.resend_api_key_configured === true && capabilities.email_from_configured === true
    );
  }
  if (mode === 'gmail_smtp') {
    return (
      capabilities.smtp_relay_configured === true ||
      (capabilities.smtp_user_configured === true &&
        capabilities.smtp_app_password_configured === true)
    );
  }
  return false;
}

/** "NOT_READY" becomes "not ready". */
export function readinessWords(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

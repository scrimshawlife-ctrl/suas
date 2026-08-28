/**
 * Click-through demo state for docs/demo.html.
 *
 * Local only. No fetch. No invented /app host. Hash navigation is the screen
 * list; this file keeps Check-In band, Consent Grant, and QRF request state
 * in memory for the tab.
 *
 * Spec citations (released stack 0.2.0, RELEASE_MANIFEST-0.2.0.md):
 * - PRODUCT.md / CONTEXT.md (consent-governed coordination; not EHR / 911)
 * - SAFETY.md §3.2 (settled effective RED opens or updates a Support Case)
 * - CHECKINS.md (qv-001 completion requests scoring)
 * - CONSENT.md §2 (Consent Grant; small scale is not an exception)
 * - MVP_REFERENCE.md §7.2 / §9 (QRF deploy/cancel; on-duty and metrics honesty)
 */
'use strict';

const SCREENS = [
  'open',
  'what-it-is',
  'what-it-is-not',
  'the-loop',
  'check-in',
  'case',
  'consent',
  'qrf',
  'unavailable',
  'real-versus-not',
  'close',
];

/** @typedef {'YELLOW' | 'ORANGE' | 'RED'} SignalBand */

const state = {
  /** @type {SignalBand | null} */
  band: null,
  /** @type {Record<string, boolean>} */
  grants: {
    'can_receive:RED': false,
    'can_view:support_signal': false,
    'can_share:service_request_fulfillment': false,
  },
  qrfOpen: false,
  joinAttempted: false,
};

/**
 * @returns {string}
 */
function currentScreenId() {
  const hash = window.location.hash.replace(/^#/, '');
  return SCREENS.includes(hash) ? hash : 'open';
}

/**
 * @param {string} id
 */
function goToScreen(id) {
  if (!SCREENS.includes(id)) {
    return;
  }
  if (window.location.hash.replace(/^#/, '') === id) {
    syncChrome();
    return;
  }
  window.location.hash = id;
}

function syncChrome() {
  const id = currentScreenId();
  const index = SCREENS.indexOf(id);

  document.querySelectorAll('[data-demo-beat]').forEach((beat) => {
    const selected = beat.getAttribute('href') === `#${id}`;
    beat.setAttribute('aria-current', selected ? 'step' : 'false');
  });

  const jump = document.getElementById('demo-jump');
  if (jump instanceof HTMLSelectElement && jump.value !== id) {
    jump.value = id;
  }

  const beatIndex = document.getElementById('demo-beat-index');
  const stepLabel = `${String(index + 1).padStart(2, '0')} / ${String(SCREENS.length).padStart(2, '0')}`;
  if (beatIndex) {
    beatIndex.textContent = stepLabel;
  }

  const back = document.getElementById('demo-back');
  const next = document.getElementById('demo-next');
  const position = document.getElementById('demo-position');
  if (back instanceof HTMLAnchorElement) {
    if (index <= 0) {
      back.href = 'index.html';
      back.textContent = 'Poster';
      back.setAttribute('aria-label', 'Back to the Pages poster');
    } else {
      back.href = `#${SCREENS[index - 1]}`;
      back.textContent = 'Back';
      back.setAttribute('aria-label', 'Previous screen');
    }
  }
  if (next instanceof HTMLAnchorElement) {
    if (index >= SCREENS.length - 1) {
      next.href = 'index.html';
      next.textContent = 'Poster';
      next.setAttribute('aria-label', 'Return to the Pages poster');
    } else {
      next.href = `#${SCREENS[index + 1]}`;
      next.textContent = 'Next';
      next.setAttribute('aria-label', 'Next screen');
    }
  }
  if (position) {
    position.textContent = stepLabel;
  }

  const heading = document.querySelector(`[data-demo-screen="${id}"] h2`);
  if (heading instanceof HTMLElement && document.activeElement !== heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);

  renderCase();
  renderConsent();
  renderQrf();
}

function renderCase() {
  const result = document.getElementById('demo-case-result');
  const badge = document.getElementById('demo-case-badge');
  if (!result || !badge) {
    return;
  }

  if (state.band === null) {
    badge.textContent = 'NO BAND';
    result.innerHTML =
      '<p>No band selected. A Support Case opens only from a settled effective <strong>RED</strong>.</p>' +
      '<p class="demo-note">Go back to Check-In and pick YELLOW, ORANGE, or RED. This page does not invent a score.</p>' +
      '<p class="demo-note">SUAS did not contact emergency services.</p>';
    return;
  }

  if (state.band === 'RED') {
    badge.textContent = 'RED · CASE OPEN';
    result.innerHTML =
      '<p>Recorded Support Signal level: <strong>RED</strong>.</p>' +
      '<p>A Support Case was opened. A settled effective RED opens or updates a Support Case.</p>' +
      '<p class="demo-note">This is local demo state. It is not a live Case on an API host.</p>' +
      '<p class="demo-note">SUAS did not contact emergency services. SUAS does not call 911.</p>';
    return;
  }

  badge.textContent = `${state.band} · NO CASE`;
  result.innerHTML =
    `<p>Recorded Support Signal level: <strong>${state.band}</strong>.</p>` +
    `<p>No Support Case was opened. <strong>YELLOW</strong> and <strong>ORANGE</strong> do not open a case.</p>` +
    '<p class="demo-note">A later RED can open a case. A closed case is not reopened. This demo does not show CLOSE.</p>' +
    '<p class="demo-note">SUAS did not contact emergency services. SUAS does not call 911.</p>';
}

function renderConsent() {
  document.querySelectorAll('[data-grant-key]').forEach((row) => {
    const key = row.getAttribute('data-grant-key');
    if (!key) {
      return;
    }
    const granted = state.grants[key] === true;
    const status = row.querySelector('[data-grant-status]');
    if (status) {
      status.textContent = granted ? 'ACTIVE' : 'REVOKED';
    }
    row.setAttribute('data-granted', granted ? 'true' : 'false');
    const grantBtn = row.querySelector('[data-grant-action="grant"]');
    const revokeBtn = row.querySelector('[data-grant-action="revoke"]');
    if (grantBtn instanceof HTMLButtonElement) {
      grantBtn.disabled = granted;
    }
    if (revokeBtn instanceof HTMLButtonElement) {
      revokeBtn.disabled = !granted;
    }
  });
}

function renderQrf() {
  const status = document.getElementById('demo-qrf-status');
  const detail = document.getElementById('demo-qrf-detail');
  const deploy = document.getElementById('demo-qrf-deploy');
  const cancel = document.getElementById('demo-qrf-cancel');
  const joinNote = document.getElementById('demo-qrf-join-note');
  if (!status || !detail) {
    return;
  }

  if (state.qrfOpen) {
    status.textContent = 'REQUESTED';
    detail.innerHTML =
      '<p>A peer-support Service Request is recorded in this tab.</p>' +
      '<p>Headline: Your request is recorded.</p>' +
      '<p class="demo-note">Local only. Not a live Deploy QRF. No responder was notified. ARRIVED is not a recorded fact and stays unshown.</p>';
  } else {
    status.textContent = 'NONE';
    detail.innerHTML =
      '<p>No peer-support request is open in this tab.</p>' +
      '<p class="demo-note">Deploy opens a request here. Cancel closes it. This is not emergency dispatch.</p>';
  }

  if (deploy instanceof HTMLButtonElement) {
    deploy.disabled = state.qrfOpen;
  }
  if (cancel instanceof HTMLButtonElement) {
    cancel.disabled = !state.qrfOpen;
  }
  if (joinNote) {
    joinNote.hidden = !state.joinAttempted;
  }
}

/**
 * @param {Event} event
 */
function onClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const bandButton = target.closest('[data-band]');
  if (bandButton instanceof HTMLButtonElement) {
    const band = bandButton.getAttribute('data-band');
    if (band === 'YELLOW' || band === 'ORANGE' || band === 'RED') {
      state.band = band;
      document.querySelectorAll('[data-band]').forEach((button) => {
        button.setAttribute('aria-pressed', button === bandButton ? 'true' : 'false');
      });
      const picked = document.getElementById('demo-band-picked');
      if (picked) {
        picked.textContent =
          band === 'RED'
            ? 'RED selected. Next screen: a Support Case opens.'
            : `${band} selected. Next screen: no Support Case.`;
      }
      renderCase();
    }
    return;
  }

  const grantButton = target.closest('[data-grant-action]');
  if (grantButton instanceof HTMLButtonElement) {
    const row = grantButton.closest('[data-grant-key]');
    const key = row?.getAttribute('data-grant-key');
    const action = grantButton.getAttribute('data-grant-action');
    if (key && Object.hasOwn(state.grants, key)) {
      state.grants[key] = action === 'grant';
      renderConsent();
    }
    return;
  }

  if (target.closest('#demo-qrf-deploy')) {
    state.qrfOpen = true;
    renderQrf();
    return;
  }
  if (target.closest('#demo-qrf-cancel')) {
    state.qrfOpen = false;
    renderQrf();
    return;
  }
  if (target.closest('#demo-qrf-join')) {
    state.joinAttempted = true;
    renderQrf();
  }
}

/**
 * @param {Event} event
 */
function onLoopClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const plate = target.closest('[data-loop-step]');
  if (!(plate instanceof HTMLButtonElement)) {
    return;
  }
  document.querySelectorAll('[data-loop-step]').forEach((step) => {
    step.setAttribute('aria-pressed', step === plate ? 'true' : 'false');
  });
  const detail = document.getElementById('demo-loop-detail');
  const copy = plate.getAttribute('data-loop-copy');
  if (detail && copy) {
    detail.textContent = copy;
  }
}

function init() {
  if (!window.location.hash) {
    window.history.replaceState(null, '', '#open');
  }

  document.addEventListener('click', onClick);
  const loop = document.getElementById('demo-loop-plates');
  if (loop) {
    loop.addEventListener('click', onLoopClick);
  }
  const jump = document.getElementById('demo-jump');
  if (jump instanceof HTMLSelectElement) {
    jump.addEventListener('change', () => {
      goToScreen(jump.value);
    });
  }
  window.addEventListener('hashchange', syncChrome);
  syncChrome();
}

init();

/**
 * Click-through demo state for docs/demo.html.
 *
 * Local only. No fetch. No invented /app host. Hash navigation is the five
 * investor screens. This file keeps Check-In band state in memory for the tab.
 * Retired hashes map to the nearest remaining screen.
 *
 * Spec citations (released stack 0.2.0, RELEASE_MANIFEST-0.2.0.md):
 * - PRODUCT.md / CONTEXT.md (consent-governed coordination; not EHR / 911)
 * - SAFETY.md §3.2 (settled effective RED opens or updates a Support Case)
 * - CHECKINS.md (qv-001 completion requests scoring)
 * - CONSENT.md §2 (Consent Grant exists; this walk does not open those controls)
 * - MVP_REFERENCE.md §7.2 / §9 (QRF deploy/cancel live in the kernel, not here)
 */
'use strict';

const SCREENS = ['open', 'what', 'loop', 'check-in', 'close'];

/**
 * Leftover hashes from the eleven-screen walk. Each value is a remaining
 * screen so old links do not blank.
 *
 * @type {Record<string, string>}
 */
const HASH_ALIASES = {
  'what-it-is': 'what',
  'what-it-is-not': 'what',
  'the-loop': 'loop',
  case: 'check-in',
  consent: 'close',
  qrf: 'close',
  unavailable: 'close',
  'real-versus-not': 'close',
};

/** @typedef {'YELLOW' | 'ORANGE' | 'RED'} SignalBand */

const state = {
  /** @type {SignalBand | null} */
  band: null,
};

/**
 * @param {string} raw
 * @returns {string}
 */
function resolveScreenId(raw) {
  if (SCREENS.includes(raw)) {
    return raw;
  }
  if (Object.hasOwn(HASH_ALIASES, raw)) {
    return HASH_ALIASES[raw];
  }
  return 'open';
}

/**
 * @returns {string}
 */
function currentScreenId() {
  const hash = window.location.hash.replace(/^#/, '');
  return resolveScreenId(hash);
}

/**
 * Rewrite retired hashes to the remaining screen they now mean.
 */
function canonicalizeHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const id = resolveScreenId(raw);
  if (!raw) {
    window.history.replaceState(null, '', `#${id}`);
    return;
  }
  if (Object.hasOwn(HASH_ALIASES, raw) && raw !== id) {
    window.history.replaceState(null, '', `#${id}`);
  }
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
  canonicalizeHash();
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
      back.setAttribute('aria-label', 'Back to the poster');
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
      next.setAttribute('aria-label', 'Return to the poster');
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
}

function renderCase() {
  const result = document.getElementById('demo-case-result');
  const badge = document.getElementById('demo-case-badge');
  if (!result || !badge) {
    return;
  }

  if (state.band === null) {
    badge.textContent = 'NONE YET';
    result.innerHTML =
      '<p>You have not picked a color yet. A support case opens only if you pick <strong>red</strong>.</p>' +
      '<p class="demo-note">SUAS did not call 911.</p>';
    return;
  }

  if (state.band === 'RED') {
    badge.textContent = 'RED · CASE OPEN';
    result.innerHTML =
      '<p>You picked <strong>red</strong>. A support case is open in this tab.</p>' +
      '<p>Red means someone may need help now. A support case is a record of that need.</p>' +
      '<p class="demo-note">This lives only in this tab. It is not a live case.</p>' +
      '<p class="demo-note">SUAS did not call 911.</p>';
    return;
  }

  badge.textContent = `${state.band} · NO CASE`;
  result.innerHTML =
    `<p>You picked <strong>${state.band.toLowerCase()}</strong>. No support case opened.</p>` +
    '<p>Yellow and orange do not open a case.</p>' +
    '<p class="demo-note">Red later can open a case. A closed case does not reopen. This walk does not show closing a case.</p>' +
    '<p class="demo-note">SUAS did not call 911.</p>';
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
      renderCase();
    }
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

(() => {
  'use strict';

  const screen = document.querySelector('[data-screen]');
  const phaseItems = [...document.querySelectorAll('[data-phase]')];
  const loopState = document.querySelector('[data-loop-state]');
  const eventName = document.querySelector('[data-event]');
  const eventDetail = document.querySelector('[data-event-detail]');
  const eventTime = document.querySelector('[data-event-time]');
  const runButton = document.querySelector('[data-command="run"]');
  const resetButton = document.querySelector('[data-command="reset"]');

  const phases = [
    'signal',
    'need',
    'consent',
    'coordination',
    'fulfillment',
    'followup',
    'settlement',
  ];
  let currentView = 'login';
  let currentPhase = -1;
  let selectedCategory = 'ride';
  let statusIndex = 0;
  let demoTimer = null;
  let isGuided = false;

  const categories = {
    ride: { title: 'Free Ride', subtitle: 'Rideshare coordination', icon: '→', destination: true },
    food: {
      title: 'Free Food',
      subtitle: 'Meal support coordination',
      icon: '●',
      destination: false,
    },
    shelter: {
      title: 'Emergency Shelter',
      subtitle: 'Temporary shelter coordination',
      icon: '⌂',
      destination: false,
    },
  };

  const statuses = [
    {
      code: 'SUBMITTED',
      headline: 'Request received. Getting it ready.',
      progress: 12,
      event: 'SERVICE_REQUEST_SUBMITTED',
    },
    {
      code: 'MATCHING',
      headline: 'Searching for available support.',
      progress: 40,
      event: 'COORDINATION_STARTED',
    },
    {
      code: 'ASSIGNED',
      headline: 'A provider was found. Waiting for acceptance.',
      progress: 62,
      event: 'PROVIDER_ASSIGNED',
    },
    {
      code: 'ACCEPTED',
      headline: 'Accepted. Help is on the way to you.',
      progress: 78,
      event: 'FULFILLMENT_ACCEPTED',
    },
    {
      code: 'IN PROGRESS',
      headline: 'In progress. Your support is en route.',
      progress: 90,
      event: 'FULFILLMENT_IN_PROGRESS',
    },
    {
      code: 'FULFILLED',
      headline: 'Delivered. Please confirm you received it.',
      progress: 98,
      event: 'FULFILLMENT_RECORDED',
    },
  ];

  function now() {
    return new Intl.DateTimeFormat('en', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());
  }

  function emit(name, detail, phase, state = 'ACTIVE') {
    eventName.textContent = name;
    eventDetail.textContent = detail;
    eventTime.textContent = now();
    loopState.textContent = state;
    if (phase !== undefined) setPhase(phase);
  }

  function setPhase(phase) {
    currentPhase = typeof phase === 'number' ? phase : phases.indexOf(phase);
    phaseItems.forEach((item, index) => {
      item.classList.toggle('complete', index < currentPhase);
      item.classList.toggle('active', index === currentPhase);
    });
  }

  function nav(title, back = false) {
    return `<div class="ios-nav">
      ${back ? '<button class="back-button" type="button" data-action="back" aria-label="Go back">‹</button>' : '<span></span>'}
      <h3>${title}</h3>
      <span class="profile-dot">V</span>
    </div>`;
  }

  function renderLogin() {
    currentView = 'login';
    screen.innerHTML = `<div class="ios-screen login">
      <div class="login-brand">
        <div class="login-seal" aria-hidden="true">S</div>
        <h3>S.U.A.S. QRF</h3>
        <p>Veteran Emergency Services</p>
      </div>
      <div class="login-card">
        <h4>Sign in to continue</h4>
        <label><span class="sr-only">Synthetic email</span><input class="ios-input" type="email" value="veteran.demo@example.test" readonly /></label>
        <button class="ios-button" type="button" data-action="login">One-tap demo sign-in</button>
      </div>
      <p class="login-footer">Help is free · Synthetic demonstration</p>
    </div>`;
    bindActions();
  }

  function renderHome() {
    currentView = 'home';
    screen.innerHTML = `<div class="ios-screen">
      ${nav('What do you need?')}
      <div class="home-heading">
        <strong>S.U.A.S. QRF</strong>
        <small>Veteran support · synthetic demo</small>
        <h2>Tap what you need.</h2>
      </div>
      <div class="service-list">
        ${serviceCard('ride', 'Free Ride', 'Rideshare, coordinated now', '→')}
        ${serviceCard('food', 'Free Food', 'Meal support, coordinated for you', '●')}
        ${serviceCard('shelter', 'Emergency Shelter', 'Temporary shelter, no payment needed', '⌂')}
      </div>
      <p class="sponsor-note">All services shown are synthetic for this demo</p>
      <div class="safety-card"><strong>In immediate danger?</strong><span>Use local emergency or approved crisis resources.</span></div>
    </div>`;
    bindActions();
  }

  function serviceCard(key, title, subtitle, icon) {
    return `<button class="service-button" type="button" data-action="select" data-category="${key}">
      <span class="service-icon ${key}" aria-hidden="true">${icon}</span>
      <span class="service-copy"><strong>${title}</strong><small>${subtitle}</small></span>
      <span class="chevron" aria-hidden="true">›</span>
    </button>`;
  }

  function renderRequest(category) {
    currentView = 'request';
    selectedCategory = category;
    const item = categories[category];
    screen.innerHTML = `<div class="ios-screen">
      ${nav('Confirm request', true)}
      <h2 class="form-title">${item.title}</h2>
      <p class="form-subtitle">Confirm the minimum details needed to coordinate this request.</p>
      <div class="form-card">
        <div class="form-row"><span class="service-icon ${category}" style="width:40px;height:40px;font-size:1rem">${item.icon}</span><div><strong>${item.title}</strong><small>${item.subtitle}</small></div></div>
      </div>
      <div class="form-card">
        <div class="form-row"><span class="row-icon">⌖</span><div><strong>Your location</strong><small>San José Diridon Station · synthetic</small></div></div>
        ${item.destination ? '<div class="form-row"><span class="row-icon">⌁</span><div><strong>Destination</strong><small>VA Palo Alto · synthetic</small></div></div>' : ''}
      </div>
      <div class="form-card">
        <label class="form-row"><input class="consent-check" type="checkbox" data-consent /><div><strong>Share these request details</strong><small>Only for coordinating this service</small></div></label>
      </div>
      <p class="boundary-note">No continuous location tracking. Consent applies only to this synthetic request and can be withdrawn before fulfillment.</p>
      <button class="ios-button" type="button" data-action="submit" disabled>Submit ${item.title}</button>
    </div>`;
    bindActions();
  }

  function renderStatus(index = statusIndex) {
    currentView = 'status';
    statusIndex = index;
    const item = categories[selectedCategory];
    const status = statuses[index];
    const confirm = index === statuses.length - 1;
    screen.innerHTML = `<div class="ios-screen">
      ${nav('Your request')}
      <div class="status-body">
        <div class="status-orb service-icon ${selectedCategory}" aria-hidden="true">${item.icon}</div>
        <h2>${item.title}</h2>
        <p>${status.headline}</p>
        <div class="progress-track"><div class="progress-bar" style="width:${status.progress}%"></div></div>
        <span class="status-pill">${status.code}</span>
        <p class="destination">⌖ ${item.destination ? 'VA Palo Alto' : 'San José Diridon Station'} · synthetic</p>
        <div class="status-actions">
          ${confirm ? '<button class="ios-button" type="button" data-action="confirm">Confirm I received this</button>' : '<button class="ios-button secondary" type="button" data-action="advance">Advance synthetic provider</button>'}
          <button class="text-action" type="button" data-action="cancel">Cancel request</button>
        </div>
      </div>
    </div>`;
    bindActions();
  }

  function renderFollowup() {
    currentView = 'followup';
    screen.innerHTML = `<div class="ios-screen">
      ${nav('Follow-up')}
      <div class="status-body">
        <div class="complete-check" aria-hidden="true">✓</div>
        <h2>Support received</h2>
        <p>Your confirmation was recorded. One last question closes the loop.</p>
        <div class="rating"><p>Did this meet your immediate need?</p><div class="rating-row">
          <button class="rating-button" type="button" data-action="rate" aria-label="No">○</button>
          <button class="rating-button" type="button" data-action="rate" aria-label="Partly">◐</button>
          <button class="rating-button" type="button" data-action="rate" aria-label="Yes">●</button>
        </div></div>
      </div>
    </div>`;
    bindActions();
  }

  function renderComplete() {
    currentView = 'complete';
    screen.innerHTML = `<div class="ios-screen">
      ${nav('Complete')}
      <div class="status-body">
        <div class="complete-check" aria-hidden="true">✓</div>
        <h2>Loop settled</h2>
        <p>This synthetic request is complete. No real service or provider was contacted.</p>
        <div class="receipt">
          <div class="receipt-row"><span>Support Case</span><strong>SYNTH-CASE-001</strong></div>
          <div class="receipt-row"><span>Request</span><strong>${categories[selectedCategory].title}</strong></div>
          <div class="receipt-row"><span>Outcome</span><strong>Confirmed</strong></div>
          <div class="receipt-row"><span>Environment</span><strong>Static demo</strong></div>
        </div>
        <div class="status-actions"><button class="ios-button" type="button" data-action="restart">Back to home</button></div>
      </div>
    </div>`;
    bindActions();
  }

  function bindActions() {
    screen.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', handleAction);
    });
    const consent = screen.querySelector('[data-consent]');
    if (consent) {
      consent.addEventListener('change', () => {
        screen.querySelector('[data-action="submit"]').disabled = !consent.checked;
        emit(
          consent.checked ? 'CONSENT_SCOPE_ACCEPTED' : 'CONSENT_SCOPE_CLEARED',
          'Veteran reviewed the synthetic request-sharing scope.',
          'consent',
        );
      });
    }
  }

  function handleAction(event) {
    stopGuided();
    const action = event.currentTarget.dataset.action;
    if (action === 'login') {
      emit(
        'SYNTHETIC_SESSION_STARTED',
        'Demo authentication completed without a credential or network call.',
        undefined,
        'SIGNED IN',
      );
      renderHome();
    } else if (action === 'select') {
      selectedCategory = event.currentTarget.dataset.category;
      emit(
        'NEED_SELECTED',
        `${categories[selectedCategory].title} selected as the current synthetic need.`,
        'need',
      );
      renderRequest(selectedCategory);
    } else if (action === 'back') {
      emit(
        'REQUEST_DRAFT_DISCARDED',
        'The unsubmitted synthetic draft was cleared.',
        'signal',
        'READY',
      );
      renderHome();
    } else if (action === 'submit') {
      statusIndex = 0;
      emit(
        'SERVICE_REQUEST_SUBMITTED',
        'Consent-scoped synthetic request entered coordination.',
        'coordination',
        'COORDINATING',
      );
      renderStatus();
    } else if (action === 'advance') {
      advanceStatus();
    } else if (action === 'confirm') {
      emit(
        'VETERAN_RECEIPT_CONFIRMED',
        'Veteran confirmed the synthetic fulfillment.',
        'fulfillment',
        'CONFIRMED',
      );
      renderFollowup();
    } else if (action === 'rate') {
      emit(
        'FOLLOW_UP_RECORDED',
        'Synthetic follow-up recorded; no clinical outcome inferred.',
        'followup',
        'FOLLOW-UP',
      );
      renderComplete();
      window.setTimeout(
        () =>
          emit(
            'SETTLEMENT_RECORDED',
            'Synthetic loop closed with an inspectable terminal state.',
            'settlement',
            'SETTLED',
          ),
        300,
      );
    } else if (action === 'cancel') {
      emit(
        'SERVICE_REQUEST_CANCELLED',
        'Synthetic request cancelled; no external effect occurred.',
        'coordination',
        'CANCELLED',
      );
      renderHome();
    } else if (action === 'restart') {
      reset(false);
      renderHome();
    }
  }

  function advanceStatus() {
    if (statusIndex < statuses.length - 1) statusIndex += 1;
    const status = statuses[statusIndex];
    const phase = statusIndex >= statuses.length - 1 ? 'fulfillment' : 'coordination';
    emit(status.event, status.headline, phase, status.code);
    renderStatus(statusIndex);
  }

  function stopGuided() {
    if (demoTimer) window.clearTimeout(demoTimer);
    demoTimer = null;
    isGuided = false;
    runButton.querySelector('span').textContent = 'Run guided demo';
  }

  function guidedStep(delay, work) {
    demoTimer = window.setTimeout(() => {
      if (!isGuided) return;
      work();
    }, delay);
  }

  function runGuided() {
    reset(false);
    isGuided = true;
    runButton.querySelector('span').textContent = 'Demo running…';
    guidedStep(650, () => {
      emit(
        'SYNTHETIC_SESSION_STARTED',
        'Demo authentication completed without a credential or network call.',
        undefined,
        'SIGNED IN',
      );
      renderHome();
      guidedStep(900, () => {
        selectedCategory = 'ride';
        emit('NEED_SELECTED', 'Free Ride selected as the current synthetic need.', 'need');
        renderRequest('ride');
        guidedStep(950, () => {
          const consent = screen.querySelector('[data-consent]');
          consent.checked = true;
          screen.querySelector('[data-action="submit"]').disabled = false;
          emit(
            'CONSENT_SCOPE_ACCEPTED',
            'Veteran reviewed the synthetic request-sharing scope.',
            'consent',
          );
          guidedStep(850, () => {
            emit(
              'SERVICE_REQUEST_SUBMITTED',
              'Consent-scoped synthetic request entered coordination.',
              'coordination',
              'COORDINATING',
            );
            statusIndex = 0;
            renderStatus();
            guidedStatus();
          });
        });
      });
    });
  }

  function guidedStatus() {
    if (!isGuided) return;
    if (statusIndex < statuses.length - 1) {
      guidedStep(800, () => {
        advanceStatus();
        guidedStatus();
      });
    } else {
      guidedStep(1000, () => {
        emit(
          'VETERAN_RECEIPT_CONFIRMED',
          'Veteran confirmed the synthetic fulfillment.',
          'fulfillment',
          'CONFIRMED',
        );
        renderFollowup();
        guidedStep(1000, () => {
          emit(
            'FOLLOW_UP_RECORDED',
            'Synthetic follow-up recorded; no clinical outcome inferred.',
            'followup',
            'FOLLOW-UP',
          );
          renderComplete();
          guidedStep(700, () => {
            emit(
              'SETTLEMENT_RECORDED',
              'Synthetic loop closed with an inspectable terminal state.',
              'settlement',
              'SETTLED',
            );
            stopGuided();
          });
        });
      });
    }
  }

  function reset(render = true) {
    stopGuided();
    currentView = 'login';
    currentPhase = -1;
    selectedCategory = 'ride';
    statusIndex = 0;
    setPhase(-1);
    emit('DEMO_READY', 'Choose Run guided demo or interact with the phone.', undefined, 'READY');
    if (render) renderLogin();
  }

  runButton.addEventListener('click', runGuided);
  resetButton.addEventListener('click', () => reset());
  renderLogin();
})();

// AGI Command — the device half of the command centre.
//
// Renders through the app's existing shell: the `[data-panel]` navigation, the
// shared `#panel-content` surface and the toast. Nothing here replaces the
// capabilities or memories UI; device control is an additional panel.
//
// Durable state on the server is the source of truth. Every SSE event triggers a
// re-read of the affected command rather than being trusted as a delta, so a
// dropped event self-heals on the next update or reload.

const EXECUTION_TONE = {
  succeeded: 'ok',
  failed: 'bad',
  timed_out: 'bad',
  unsupported: 'warn',
  rejected: 'warn',
  device_offline: 'warn',
  expired: 'warn',
  cancelled: 'muted',
  queued: 'warn',
  waiting_for_confirmation: 'warn',
};

const DERIVED_GROUPS = ['phones', 'tablets', 'computers', 'browsers', 'all'];

export function createCommandCentre({ api, orb, setState, showToast }) {
  const state = {
    enabled: false,
    gateway: { configured: false, reachable: false },
    devices: [],
    workflows: [],
    capabilities: [],
    browserDeviceId: null,
    activeCommandId: null,
    stream: null,
    browserInFlight: new Map(),
    voiceBackend: 'browser',
  };

  const el = {
    commandStrip: () => document.querySelector('#command-strip'),
    confirmationArea: () => document.querySelector('#confirmation-area'),
    gatewayBadge: () => document.querySelector('#gateway-badge'),
    presence: () => document.querySelector('#agi-presence'),
    panelContent: () => document.querySelector('#panel-content'),
    navDevices: () => document.querySelector('#nav-devices'),
    navFlows: () => document.querySelector('#nav-flows'),
    navCount: () => document.querySelector('#nav-devices-count'),
  };

  class DeviceUnsupported extends Error {}
  class DeviceRejection extends Error {}

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async function refreshStatus() {
    let status;
    try {
      status = await api('/api/agi-command/status');
    } catch {
      state.enabled = false;
      applyVisibility();
      return null;
    }
    state.enabled = Boolean(status.enabled);
    state.gateway = status.gateway ?? { configured: false, reachable: false };
    state.voiceBackend = status.voice?.backend ?? 'browser';
    applyVisibility();

    if (!state.enabled) return status;

    const badge = el.gatewayBadge();
    if (badge) {
      if (!state.gateway.configured) {
        badge.className = 'gateway-badge tone-off';
        badge.textContent = 'No gateway configured';
      } else if (!state.gateway.reachable) {
        // Honest: the feature is on but device control cannot work right now.
        badge.className = 'gateway-badge tone-bad';
        badge.textContent = 'Gateway unreachable';
        badge.title = state.gateway.error ?? '';
      } else {
        badge.className = 'gateway-badge tone-ok';
        badge.textContent = `Gateway online · ${state.gateway.connections ?? 0} connected`;
        badge.title = '';
      }
    }

    updateNavCount(status.devices?.online ?? 0, status.devices?.total ?? 0);
    for (const confirmation of status.openConfirmations ?? []) renderConfirmation(confirmation);
    return status;
  }

  /** Device UI only appears when the server actually offers device control. */
  function applyVisibility() {
    for (const node of [el.navDevices(), el.navFlows(), el.presence()]) {
      node?.classList.toggle('hidden', !state.enabled);
    }
  }

  function updateNavCount(online, total) {
    const badge = el.navCount();
    if (badge) badge.textContent = total > 0 ? `${online}/${total}` : '';
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async function refreshDevices() {
    if (!state.enabled) return;
    try {
      state.devices = (await api('/api/devices')).devices ?? [];
    } catch {
      state.devices = [];
    }
    updateNavCount(state.devices.filter((d) => d.online).length, state.devices.length);
    if (document.querySelector('#device-list')) renderDevicePanel();
  }

  function renderDevicePanel() {
    const host = el.panelContent();
    if (!host) return;
    host.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.appendChild(button('Pair a device', startPairing, 'primary'));
    actions.appendChild(button('Use this browser as a device', registerBrowserDevice));
    host.appendChild(actions);

    const pairingBox = document.createElement('div');
    pairingBox.id = 'pairing-box';
    pairingBox.className = 'pairing-box hidden';
    pairingBox.setAttribute('aria-live', 'polite');
    host.appendChild(pairingBox);

    const list = document.createElement('div');
    list.id = 'device-list';
    host.appendChild(list);

    if (state.devices.length === 0) {
      list.innerHTML =
        '<p class="panel-empty">No devices paired yet. Choose “Pair a device” to add one.</p>';
    } else {
      for (const device of state.devices) list.appendChild(deviceCard(device));
    }

    const note = document.createElement('p');
    note.className = 'panel-note';
    note.textContent =
      'AGI Command cannot unlock a locked device, bypass a PIN or biometrics, record audio or video, or run arbitrary commands. Those are not implemented.';
    host.appendChild(note);
  }

  function deviceCard(device) {
    const card = document.createElement('article');
    card.className = 'device-card';

    const header = document.createElement('div');
    header.className = 'device-header';
    const dot = document.createElement('span');
    dot.className = `status-dot ${device.online ? 'online' : 'offline'}`;
    // Colour is never the only signal — the label spells it out.
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', device.online ? 'online' : 'offline');
    header.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'device-name';
    name.textContent = device.name;
    header.appendChild(name);

    if (device.isPrimary) {
      const badge = document.createElement('span');
      badge.className = 'device-badge';
      badge.textContent = 'primary';
      header.appendChild(badge);
    }
    card.appendChild(header);

    const meta = document.createElement('p');
    meta.className = 'device-meta';
    meta.textContent = `${device.deviceType.replace(/_/g, ' ')} · ${device.online ? 'online' : 'offline'}`;
    card.appendChild(meta);

    const usable = (device.capabilities ?? []).filter((c) => c.advertised);
    if (usable.length > 0) {
      const caps = document.createElement('details');
      caps.className = 'device-caps';
      const summary = document.createElement('summary');
      summary.textContent = `${usable.filter((c) => c.enabled).length}/${usable.length} capabilities enabled`;
      caps.appendChild(summary);
      for (const capability of usable) {
        const row = document.createElement('label');
        row.className = 'cap-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = capability.enabled;
        box.addEventListener('change', async () => {
          try {
            await api(`/api/devices/${device.id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                capabilities: [{ capability: capability.capability, enabled: box.checked }],
              }),
            });
            await refreshDevices();
          } catch (error) {
            box.checked = !box.checked;
            showToast(error.message);
          }
        });
        row.appendChild(box);
        row.appendChild(document.createTextNode(` ${capability.capability}`));
        caps.appendChild(row);
      }
      card.appendChild(caps);
    }

    const actions = document.createElement('div');
    actions.className = 'device-actions';
    actions.appendChild(
      button('Rename', async () => {
        const next = prompt(`Rename "${device.name}" to:`, device.name);
        if (!next || next === device.name) return;
        await api(`/api/devices/${device.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: next }),
        });
        await refreshDevices();
      }),
    );
    if (!device.isPrimary) {
      actions.appendChild(
        button('Make primary', async () => {
          await api(`/api/devices/${device.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isPrimary: true }),
          });
          await refreshDevices();
        }),
      );
    }
    actions.appendChild(
      button('Rotate credential', async () => {
        if (!confirm(`Issue a new credential for "${device.name}"? The old one stops working immediately.`)) return;
        const body = await api(`/api/devices/${device.id}/rotate-credential`, { method: 'POST' });
        showSecretOnce(`New credential for ${device.name}`, body.credential);
      }),
    );
    actions.appendChild(
      button(
        'Revoke',
        async () => {
          if (!confirm(`Revoke "${device.name}"? It will not be able to reconnect.`)) return;
          await api(`/api/devices/${device.id}`, { method: 'DELETE' });
          showToast(`${device.name} revoked.`);
          await refreshDevices();
        },
        'danger',
      ),
    );
    card.appendChild(actions);
    return card;
  }

  async function startPairing() {
    const session = await api('/api/devices/pairing-sessions', { method: 'POST' });
    const box = document.querySelector('#pairing-box');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = '';

    const code = document.createElement('div');
    code.className = 'pairing-code';
    code.textContent = session.code;
    box.appendChild(code);

    const help = document.createElement('p');
    help.className = 'pairing-help';
    box.appendChild(help);

    const example = document.createElement('code');
    example.className = 'pairing-example';
    example.textContent = `npm run simulate-device -- --name "Phone One" --type android_phone --code ${session.code}`;
    box.appendChild(example);

    // Count down, then stop showing a code that no longer works.
    let remaining = session.expiresInSeconds;
    const tick = () => {
      help.textContent = `Enter this code on the device within ${remaining}s. It can only be used once.`;
    };
    tick();
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        box.innerHTML = '<p class="pairing-help">That code has expired. Generate a new one.</p>';
        return;
      }
      tick();
    }, 1000);
  }

  async function registerBrowserDevice() {
    const body = await api('/api/devices/browser-session', {
      method: 'POST',
      body: JSON.stringify({ name: 'This browser' }),
    });
    state.browserDeviceId = body.deviceId;
    showToast(`This browser is registered as "${body.deviceName}".`);
    await refreshDevices();
  }

  // -------------------------------------------------------------------------
  // The browser acting as a device
  // -------------------------------------------------------------------------

  const browserHandlers = {
    'device.ping': async () => ({ roundTripMs: 0 }),
    'device.status': async () => ({
      online: navigator.onLine,
      network: navigator.onLine ? 'online' : 'offline',
      tabVisible: document.visibilityState === 'visible',
    }),
    'url.open': async (parameters) => {
      const parsed = new URL(String(parameters.url ?? ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new DeviceRejection('only http and https URLs can be opened');
      }
      const opened = window.open(parsed.href, '_blank', 'noopener');
      if (!opened) {
        // Pop-up blockers are real; say so instead of reporting a false success.
        throw new DeviceRejection(
          'the browser blocked the pop-up — allow pop-ups for this site to open links here',
        );
      }
      return { opened: true };
    },
    'notification.show': async (parameters) => {
      if (!('Notification' in window)) {
        throw new DeviceUnsupported('this browser cannot show notifications');
      }
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new DeviceRejection('notification permission was refused');
      new Notification(String(parameters.title ?? 'AGI-v1'), {
        body: String(parameters.body ?? ''),
      });
      return { shown: true };
    },
  };

  async function handleBrowserDispatch(event) {
    const key = `${event.commandId}:${event.executionId}`;
    if (state.browserInFlight.has(key)) {
      await postBrowserResult(event, 'failed', {
        failure: { code: 'duplicate', message: 'already handled in this tab' },
      });
      return;
    }
    state.browserInFlight.set(key, true);
    await postBrowserResult(event, 'acknowledged');

    try {
      if (event.expiresAt && event.expiresAt <= Date.now()) {
        await postBrowserResult(event, 'failed', {
          failure: { code: 'rejected', message: 'the command expired before it arrived' },
        });
        return;
      }
      const handler = browserHandlers[event.capability];
      if (!handler) {
        await postBrowserResult(event, 'failed', {
          failure: {
            code: 'unsupported',
            message: `${event.capability} is not available in a browser tab`,
          },
        });
        return;
      }
      const result = await handler(event.parameters ?? {});
      await postBrowserResult(event, 'completed', { result });
    } catch (err) {
      const code =
        err instanceof DeviceUnsupported
          ? 'unsupported'
          : err instanceof DeviceRejection
            ? 'rejected'
            : 'failed';
      await postBrowserResult(event, 'failed', { failure: { code, message: err.message } });
    } finally {
      state.browserInFlight.delete(key);
    }
  }

  async function postBrowserResult(event, type, extra = {}) {
    try {
      await api('/api/agi-command/browser-result', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: event.deviceId,
          commandId: event.commandId,
          executionId: event.executionId,
          type,
          ...extra,
        }),
      });
    } catch {
      // The server's timeout sweep will resolve the execution honestly.
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async function showCommand(commandId) {
    if (!commandId) return;
    state.activeCommandId = commandId;
    try {
      renderCommand((await api(`/api/device-commands/${commandId}`)).command);
    } catch {
      /* the command list will catch up on reload */
    }
  }

  function renderCommand(command) {
    const strip = el.commandStrip();
    if (!strip) return;
    strip.classList.remove('hidden');
    strip.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'command-header';
    header.textContent = `${command.capability} — ${command.status.replace(/_/g, ' ')}`;
    strip.appendChild(header);

    const list = document.createElement('div');
    list.className = 'execution-list';
    for (const execution of command.executions) {
      const row = document.createElement('div');
      row.className = `execution tone-${EXECUTION_TONE[execution.state] ?? 'muted'}`;
      const name = document.createElement('span');
      name.className = 'execution-device';
      name.textContent = execution.deviceName;
      const label = document.createElement('span');
      label.className = 'execution-state';
      label.textContent = execution.label + (execution.detail ? ` — ${execution.detail}` : '');
      row.appendChild(name);
      row.appendChild(label);
      list.appendChild(row);
    }
    strip.appendChild(list);

    const openStates = ['dispatching', 'dispatched', 'acknowledged', 'running', 'queued', 'pending'];
    const hasOpen = command.executions.some((e) => openStates.includes(e.state));
    const hasFailed = command.executions.some((e) =>
      ['failed', 'timed_out', 'device_offline', 'expired'].includes(e.state),
    );

    const actions = document.createElement('div');
    actions.className = 'command-actions';
    if (hasOpen) {
      actions.appendChild(
        button('Cancel', async () => {
          const body = await api(`/api/device-commands/${command.id}/cancel`, { method: 'POST' });
          if (body.note) showToast(body.note);
          renderCommand(body.command);
        }),
      );
    }
    if (hasFailed) {
      actions.appendChild(
        button('Retry failed', async () => {
          const body = await api(`/api/device-commands/${command.id}/retry`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          state.activeCommandId = body.command.id;
          renderCommand(body.command);
        }),
      );
    }
    if (actions.children.length > 0) strip.appendChild(actions);

    // Drive the orb from real command state rather than from optimism.
    if (hasOpen) setState('executing');
    else if (command.status === 'succeeded') setState('success');
    else if (command.status === 'partially_succeeded') setState('partial');
    else if (command.status === 'failed') setState('error');
  }

  function renderConfirmation(confirmation) {
    const area = el.confirmationArea();
    if (!area || document.querySelector(`[data-confirmation="${confirmation.id}"]`)) return;

    const card = document.createElement('div');
    card.className = 'confirmation-card';
    card.dataset.confirmation = confirmation.id;

    const title = document.createElement('div');
    title.className = 'confirmation-title';
    title.textContent = 'Confirm before I do this';
    card.appendChild(title);

    const summary = document.createElement('div');
    summary.className = 'confirmation-summary';
    summary.textContent = confirmation.summary;
    card.appendChild(summary);

    const actions = document.createElement('div');
    actions.className = 'confirmation-actions';

    const respond = async (confirm) => {
      card.remove();
      try {
        if (confirmation.workflowRunId) {
          const body = await api(`/api/workflows/runs/${confirmation.workflowRunId}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ confirm }),
          });
          showToast(
            confirm ? `${body.workflowName}: ${body.steps.length} step(s) run.` : 'Workflow cancelled.',
          );
        } else if (confirmation.commandId) {
          const body = await api(`/api/device-commands/${confirmation.commandId}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ confirm }),
          });
          renderCommand(body.command);
        }
      } catch (error) {
        showToast(error.message);
      }
      setState('idle');
    };

    actions.appendChild(button('Go ahead', () => respond(true), 'primary'));
    const no = button('No', () => respond(false));
    actions.appendChild(no);
    card.appendChild(actions);
    area.appendChild(card);

    setState('confirming');
    // Keyboard users land on the safe option first.
    no.focus();
  }

  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------

  async function refreshWorkflows() {
    if (!state.enabled) return;
    try {
      state.workflows = (await api('/api/workflows')).workflows ?? [];
    } catch {
      state.workflows = [];
    }
    if (document.querySelector('#workflow-list')) renderWorkflowPanel();
  }

  function renderWorkflowPanel() {
    const host = el.panelContent();
    if (!host) return;
    host.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.appendChild(button('New workflow', () => openWorkflowEditor(), 'primary'));
    host.appendChild(actions);

    const list = document.createElement('div');
    list.id = 'workflow-list';
    host.appendChild(list);

    if (state.workflows.length === 0) {
      list.innerHTML =
        '<p class="panel-empty">No workflows yet. Create one to run several devices at once.</p>';
      return;
    }

    for (const workflow of state.workflows) {
      const card = document.createElement('article');
      card.className = 'workflow-card';

      const name = document.createElement('div');
      name.className = 'device-name';
      name.textContent = workflow.name;
      card.appendChild(name);

      if (workflow.description) {
        const description = document.createElement('p');
        description.className = 'device-meta';
        description.textContent = workflow.description;
        card.appendChild(description);
      }

      const steps = document.createElement('p');
      steps.className = 'workflow-steps-summary';
      steps.textContent = workflow.steps.map((s, i) => `${i + 1}. ${s.capability}`).join(' · ');
      card.appendChild(steps);

      const rowActions = document.createElement('div');
      rowActions.className = 'device-actions';
      rowActions.appendChild(
        button(
          'Run',
          async () => {
            const body = await api(`/api/workflows/${workflow.id}/run`, {
              method: 'POST',
              body: JSON.stringify({}),
            });
            if (body.confirmation) {
              renderConfirmation({
                ...body.confirmation,
                workflowRunId: body.runId,
                commandId: null,
              });
              showToast('Confirm the workflow in the conversation view.');
            }
          },
          'primary',
        ),
      );
      rowActions.appendChild(
        button(
          'Delete',
          async () => {
            if (!confirm(`Delete workflow "${workflow.name}"?`)) return;
            await api(`/api/workflows/${workflow.id}`, { method: 'DELETE' });
            await refreshWorkflows();
          },
          'danger',
        ),
      );
      card.appendChild(rowActions);
      list.appendChild(card);
    }
  }

  /** Minimal editor: capability, target and JSON parameters per step. */
  function openWorkflowEditor() {
    const host = el.panelContent();
    if (!host) return;
    host.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'workflow-editor';

    const name = labelledInput(form, 'Name', 'text');
    const description = labelledInput(form, 'Description (optional)', 'text');

    const stepsHost = document.createElement('div');
    stepsHost.className = 'workflow-steps';
    form.appendChild(stepsHost);

    const addStep = () => {
      const row = document.createElement('div');
      row.className = 'workflow-step-row';

      const capability = document.createElement('select');
      capability.className = 'step-capability';
      for (const cap of state.capabilities) {
        const option = document.createElement('option');
        option.value = cap.name;
        option.textContent = `${cap.name} — ${cap.description}`;
        capability.appendChild(option);
      }
      row.appendChild(capability);

      const target = document.createElement('input');
      target.className = 'step-target';
      target.placeholder = 'target: a device name, or a group like "phones"';
      row.appendChild(target);

      const params = document.createElement('input');
      params.className = 'step-params';
      params.placeholder = 'parameters as JSON, e.g. {"appId":"youtube"}';
      row.appendChild(params);

      row.appendChild(button('Remove', () => row.remove(), 'danger'));
      stepsHost.appendChild(row);
    };
    addStep();

    const error = document.createElement('p');
    error.className = 'panel-error';

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.appendChild(button('Add step', addStep));
    actions.appendChild(
      button(
        'Save workflow',
        async () => {
          error.textContent = '';
          try {
            const steps = Array.from(stepsHost.querySelectorAll('.workflow-step-row')).map((row) => {
              const targetText = row.querySelector('.step-target').value.trim();
              const paramsText = row.querySelector('.step-params').value.trim();
              return {
                capability: row.querySelector('.step-capability').value,
                parameters: paramsText ? JSON.parse(paramsText) : {},
                // A bare plural is a group; anything else is a device name.
                targetExpression: targetText
                  ? DERIVED_GROUPS.includes(targetText.toLowerCase())
                    ? { includeGroups: [targetText.toLowerCase()] }
                    : { includeDeviceNames: [targetText] }
                  : {},
              };
            });
            if (steps.length === 0) throw new Error('Add at least one step.');
            await api('/api/workflows', {
              method: 'POST',
              body: JSON.stringify({
                name: name.value.trim(),
                description: description.value.trim() || null,
                steps,
              }),
            });
            await refreshWorkflows();
            showToast('Workflow saved.');
          } catch (err) {
            error.textContent =
              err instanceof SyntaxError ? 'Parameters must be valid JSON.' : err.message;
          }
        },
        'primary',
      ),
    );
    actions.appendChild(button('Cancel', () => renderWorkflowPanel()));

    form.appendChild(actions);
    form.appendChild(error);
    host.appendChild(form);
    name.focus();
  }

  async function loadCapabilities() {
    try {
      state.capabilities = (await api('/api/device-capabilities')).capabilities ?? [];
    } catch {
      state.capabilities = [];
    }
  }

  // -------------------------------------------------------------------------
  // Live stream
  // -------------------------------------------------------------------------

  function connectStream() {
    if (!state.enabled || state.stream) return;
    const source = new EventSource('/api/agi-command/stream', { withCredentials: true });
    state.stream = source;

    source.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      handleStreamEvent(event);
    };

    source.onerror = () => {
      // EventSource reconnects on its own; durable state means nothing is lost.
      source.close();
      state.stream = null;
      setTimeout(connectStream, 3000);
    };
  }

  function handleStreamEvent(event) {
    switch (event.kind) {
      case 'device.connected':
      case 'device.disconnected':
      case 'device.updated':
      case 'device.revoked':
        void refreshDevices();
        // Also re-read the gateway's connection count, otherwise the header
        // keeps showing whatever was true when the page loaded.
        void refreshStatus();
        break;
      // A newly created command takes over the strip — it is what the user just
      // asked for. Updates only redraw the command already on screen, so a late
      // result from an older command cannot hijack the view.
      case 'command.created':
        void showCommand(event.commandId);
        break;
      case 'execution.updated':
      case 'command.updated':
        if (!state.activeCommandId || event.commandId === state.activeCommandId) {
          void showCommand(event.commandId);
        }
        break;
      case 'confirmation.requested':
        renderConfirmation({
          id: event.confirmationId,
          commandId: event.commandId,
          summary: event.summary ?? 'this action',
        });
        break;
      case 'confirmation.resolved':
        document.querySelector(`[data-confirmation="${event.confirmationId}"]`)?.remove();
        break;
      case 'browser.dispatch':
        void handleBrowserDispatch(event);
        break;
      case 'browser.cancel':
        // The page's capabilities are short and synchronous; there is nothing to
        // interrupt, and the server has already recorded the cancellation.
        break;
    }
  }

  // -------------------------------------------------------------------------

  function button(label, onClick, variant) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className =
      variant === 'primary'
        ? 'panel-button primary'
        : `panel-button${variant === 'danger' ? ' danger' : ''}`;
    element.textContent = label;
    element.addEventListener('click', () => {
      Promise.resolve(onClick()).catch((err) => showToast(err.message));
    });
    return element;
  }

  function labelledInput(host, labelText, type) {
    const label = document.createElement('label');
    label.className = 'panel-field';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = type;
    label.appendChild(input);
    host.appendChild(label);
    return input;
  }

  function showSecretOnce(title, secret) {
    const box = document.querySelector('#pairing-box');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = '';
    const heading = document.createElement('p');
    heading.className = 'pairing-help';
    heading.textContent = `${title} — copy it now, it will not be shown again.`;
    const value = document.createElement('code');
    value.className = 'pairing-example';
    value.textContent = secret;
    box.appendChild(heading);
    box.appendChild(value);
  }

  return {
    state,
    async init() {
      const status = await refreshStatus();
      if (!state.enabled) return status;
      await Promise.all([refreshDevices(), refreshWorkflows(), loadCapabilities()]);
      connectStream();
      return status;
    },
    refreshStatus,
    refreshDevices,
    refreshWorkflows,
    renderDevicePanel,
    renderWorkflowPanel,
    showCommand,
    getBrowserDeviceId() {
      return (
        state.browserDeviceId ??
        state.devices.find((d) => d.deviceType === 'browser')?.id ??
        null
      );
    },
    clearCommandStrip() {
      const strip = el.commandStrip();
      if (strip) {
        strip.classList.add('hidden');
        strip.innerHTML = '';
      }
      state.activeCommandId = null;
    },
  };
}

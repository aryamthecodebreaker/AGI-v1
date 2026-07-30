// AGI Command — the device half of the command centre.
//
// Responsibilities:
//   * render the device panel, command strip, confirmation cards and workflows
//   * hold the SSE connection that pushes live device/command updates
//   * act as the browser device: execute the small set of capabilities a page
//     can honestly perform, and report real results back
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

export function createCommandCentre({ api, orb, voice, setState, notify }) {
  const state = {
    enabled: false,
    gateway: { configured: false, reachable: false },
    devices: [],
    workflows: [],
    capabilities: [],
    browserDeviceId: null,
    activeCommandId: null,
    stream: null,
    /** Command ids the browser device is currently working on. */
    browserInFlight: new Map(),
  };

  const el = {
    deviceSummary: document.querySelector('#device-summary'),
    deviceList: document.querySelector('#device-list'),
    pairingBox: document.querySelector('#pairing-box'),
    workflowList: document.querySelector('#workflow-list'),
    commandStrip: document.querySelector('#command-strip'),
    confirmationArea: document.querySelector('#confirmation-area'),
    gatewayBadge: document.querySelector('#gateway-badge'),
  };

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async function refreshStatus() {
    let status;
    try {
      status = await api('/api/agi-command/status');
    } catch {
      state.enabled = false;
      renderGatewayBadge('unavailable', 'Device control unavailable');
      return;
    }
    state.enabled = status.enabled;
    state.gateway = status.gateway ?? { configured: false, reachable: false };

    if (!status.enabled) {
      renderGatewayBadge('off', 'Device control is off on this server');
      el.deviceSummary.textContent = '';
      el.deviceList.innerHTML =
        '<div class="empty-state">AGI Command is switched off on this server.</div>';
      return status;
    }

    if (!state.gateway.configured) {
      renderGatewayBadge('off', 'No device gateway configured');
    } else if (!state.gateway.reachable) {
      // Honest: the feature is on but device control cannot work right now.
      renderGatewayBadge('bad', `Gateway unreachable${state.gateway.error ? ` — ${state.gateway.error}` : ''}`);
    } else {
      renderGatewayBadge('ok', `Gateway online · ${state.gateway.connections ?? 0} connected`);
    }

    el.deviceSummary.textContent = `${status.devices.online}/${status.devices.total} devices online`;

    for (const confirmation of status.openConfirmations ?? []) {
      renderConfirmation(confirmation);
    }
    return status;
  }

  function renderGatewayBadge(tone, text) {
    el.gatewayBadge.className = `centre-gateway tone-${tone}`;
    el.gatewayBadge.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async function refreshDevices() {
    if (!state.enabled) return;
    try {
      const body = await api('/api/devices');
      state.devices = body.devices ?? [];
    } catch {
      state.devices = [];
    }
    renderDevices();
    const online = state.devices.filter((d) => d.online).length;
    el.deviceSummary.textContent = `${online}/${state.devices.length} devices online`;
  }

  function renderDevices() {
    el.deviceList.innerHTML = '';
    if (state.devices.length === 0) {
      el.deviceList.innerHTML =
        '<div class="empty-state">No devices paired yet. Choose “Pair a device”.</div>';
      return;
    }
    for (const device of state.devices) {
      const card = document.createElement('div');
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

      const meta = document.createElement('div');
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
            } catch (err) {
              box.checked = !box.checked;
              notify(err.message);
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
          try {
            await api(`/api/devices/${device.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ name: next }),
            });
            await refreshDevices();
          } catch (err) {
            notify(err.message);
          }
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
          const body = await api(`/api/devices/${device.id}/rotate-credential`, {
            method: 'POST',
          });
          // Shown once, and only here — it is never stored in the page.
          showSecretOnce(`New credential for ${device.name}`, body.credential);
        }),
      );
      actions.appendChild(
        button(
          'Revoke',
          async () => {
            if (!confirm(`Revoke "${device.name}"? It will not be able to reconnect.`)) return;
            await api(`/api/devices/${device.id}`, { method: 'DELETE' });
            await refreshDevices();
          },
          'danger',
        ),
      );
      card.appendChild(actions);
      el.deviceList.appendChild(card);
    }
  }

  async function startPairing() {
    try {
      const session = await api('/api/devices/pairing-sessions', { method: 'POST' });
      el.pairingBox.classList.remove('hidden');
      el.pairingBox.innerHTML = '';

      const code = document.createElement('div');
      code.className = 'pairing-code';
      code.textContent = session.code;
      el.pairingBox.appendChild(code);

      const help = document.createElement('div');
      help.className = 'pairing-help';
      help.textContent = `Enter this code on the device within ${session.expiresInSeconds}s. It can only be used once.`;
      el.pairingBox.appendChild(help);

      const example = document.createElement('code');
      example.className = 'pairing-example';
      example.textContent = `npm run simulate-device -- --name "Phone One" --type android_phone --code ${session.code}`;
      el.pairingBox.appendChild(example);

      // Count down, then stop showing a code that no longer works.
      let remaining = session.expiresInSeconds;
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          el.pairingBox.innerHTML =
            '<div class="pairing-help">That code has expired. Generate a new one.</div>';
          return;
        }
        help.textContent = `Enter this code on the device within ${remaining}s. It can only be used once.`;
      }, 1000);
    } catch (err) {
      notify(err.message);
    }
  }

  async function registerBrowserDevice() {
    try {
      const body = await api('/api/devices/browser-session', {
        method: 'POST',
        body: JSON.stringify({ name: 'This browser' }),
      });
      state.browserDeviceId = body.deviceId;
      notify(`This browser is registered as "${body.deviceName}".`);
      await refreshDevices();
    } catch (err) {
      notify(err.message);
    }
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
      const url = String(parameters.url ?? '');
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new DeviceRejection('only http and https URLs can be opened');
      }
      const opened = window.open(url, '_blank', 'noopener');
      if (!opened) {
        // Popup blockers are real; say so instead of reporting a false success.
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
      if (permission !== 'granted') {
        throw new DeviceRejection('notification permission was refused');
      }
      new Notification(String(parameters.title ?? 'AGI-v1'), {
        body: String(parameters.body ?? ''),
      });
      return { shown: true };
    },
  };

  class DeviceUnsupported extends Error {}
  class DeviceRejection extends Error {}

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

    if (event.expiresAt && event.expiresAt <= Date.now()) {
      await postBrowserResult(event, 'failed', {
        failure: { code: 'rejected', message: 'the command expired before it arrived' },
      });
      state.browserInFlight.delete(key);
      return;
    }

    const handler = browserHandlers[event.capability];
    if (!handler) {
      await postBrowserResult(event, 'failed', {
        failure: { code: 'unsupported', message: `${event.capability} is not available in a browser tab` },
      });
      state.browserInFlight.delete(key);
      return;
    }

    try {
      const result = await handler(event.parameters ?? {});
      await postBrowserResult(event, 'completed', { result });
    } catch (err) {
      const code =
        err instanceof DeviceUnsupported
          ? 'unsupported'
          : err instanceof DeviceRejection
            ? 'rejected'
            : 'failed';
      await postBrowserResult(event, 'failed', {
        failure: { code, message: err.message },
      });
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
    let body;
    try {
      body = await api(`/api/device-commands/${commandId}`);
    } catch {
      return;
    }
    renderCommand(body.command);
  }

  function renderCommand(command) {
    el.commandStrip.classList.remove('hidden');
    el.commandStrip.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'command-header';
    header.textContent = `${command.capability} — ${command.status.replace(/_/g, ' ')}`;
    el.commandStrip.appendChild(header);

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
    el.commandStrip.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'command-actions';
    const openStates = ['dispatching', 'dispatched', 'acknowledged', 'running', 'queued', 'pending'];
    const hasOpen = command.executions.some((e) => openStates.includes(e.state));
    const hasFailed = command.executions.some((e) =>
      ['failed', 'timed_out', 'device_offline', 'expired'].includes(e.state),
    );
    if (hasOpen) {
      actions.appendChild(
        button('Cancel', async () => {
          const body = await api(`/api/device-commands/${command.id}/cancel`, { method: 'POST' });
          if (body.note) notify(body.note);
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
          renderCommand(body.command);
          state.activeCommandId = body.command.id;
        }),
      );
    }
    if (actions.children.length > 0) el.commandStrip.appendChild(actions);

    // Drive the orb from real command state rather than from optimism.
    if (hasOpen) orb.setState('executing');
    else if (command.status === 'succeeded') orb.setState('success');
    else if (command.status === 'partially_succeeded') orb.setState('partial');
    else if (command.status === 'failed') orb.setState('error');
  }

  function renderConfirmation(confirmation) {
    if (document.querySelector(`[data-confirmation="${confirmation.id}"]`)) return;

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
          const body = await api(
            `/api/workflows/runs/${confirmation.workflowRunId}/confirm`,
            { method: 'POST', body: JSON.stringify({ confirm }) },
          );
          notify(
            confirm
              ? `${body.workflowName}: ${body.steps.length} step(s) run.`
              : 'Workflow cancelled.',
          );
        } else if (confirmation.commandId) {
          const body = await api(`/api/device-commands/${confirmation.commandId}/confirm`, {
            method: 'POST',
            body: JSON.stringify({ confirm }),
          });
          renderCommand(body.command);
        }
      } catch (err) {
        notify(err.message);
      }
      setState('idle');
    };

    const yes = button('Go ahead', () => respond(true), 'primary');
    const no = button('No', () => respond(false));
    actions.appendChild(yes);
    actions.appendChild(no);
    card.appendChild(actions);

    el.confirmationArea.appendChild(card);
    orb.setState('confirming');
    // Keyboard users land on the safe option first.
    no.focus();
  }

  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------

  async function refreshWorkflows() {
    if (!state.enabled) return;
    try {
      const body = await api('/api/workflows');
      state.workflows = body.workflows ?? [];
    } catch {
      state.workflows = [];
    }
    el.workflowList.innerHTML = '';
    if (state.workflows.length === 0) {
      el.workflowList.innerHTML =
        '<div class="empty-state">No workflows yet. Create one to run several devices at once.</div>';
      return;
    }
    for (const workflow of state.workflows) {
      const card = document.createElement('div');
      card.className = 'workflow-card';

      const name = document.createElement('div');
      name.className = 'workflow-name';
      name.textContent = workflow.name;
      card.appendChild(name);

      const steps = document.createElement('div');
      steps.className = 'workflow-steps-summary';
      steps.textContent = workflow.steps
        .map((s, i) => `${i + 1}. ${s.capability}`)
        .join(' · ');
      card.appendChild(steps);

      const actions = document.createElement('div');
      actions.className = 'device-actions';
      actions.appendChild(
        button('Run', async () => {
          try {
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
            }
          } catch (err) {
            notify(err.message);
          }
        }),
      );
      actions.appendChild(
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
      card.appendChild(actions);
      el.workflowList.appendChild(card);
    }
  }

  async function loadCapabilities() {
    try {
      const body = await api('/api/device-capabilities');
      state.capabilities = body.capabilities ?? [];
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
      // A newly created command takes over the strip — it is what the user
      // just asked for. Updates only redraw the command already on screen, so
      // a late result from an older command cannot hijack the view.
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
      case 'confirmation.resolved': {
        const card = document.querySelector(`[data-confirmation="${event.confirmationId}"]`);
        card?.remove();
        break;
      }
      case 'browser.dispatch':
        void handleBrowserDispatch(event);
        break;
      case 'browser.cancel': {
        // The page's capabilities are all short and synchronous; nothing to
        // interrupt, and the server has already recorded the cancellation.
        break;
      }
    }
  }

  // -------------------------------------------------------------------------

  function button(label, onClick, variant) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = variant === 'primary' ? 'primary small' : `ghost-btn${variant === 'danger' ? ' danger' : ''}`;
    element.textContent = label;
    element.addEventListener('click', () => {
      Promise.resolve(onClick()).catch((err) => notify(err.message));
    });
    return element;
  }

  function showSecretOnce(title, secret) {
    el.pairingBox.classList.remove('hidden');
    el.pairingBox.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'pairing-help';
    heading.textContent = `${title} — copy it now, it will not be shown again.`;
    const value = document.createElement('code');
    value.className = 'pairing-example';
    value.textContent = secret;
    el.pairingBox.appendChild(heading);
    el.pairingBox.appendChild(value);
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
    showCommand,
    renderConfirmation,
    startPairing,
    registerBrowserDevice,
    getBrowserDeviceId() {
      return (
        state.browserDeviceId ??
        state.devices.find((d) => d.deviceType === 'browser')?.id ??
        null
      );
    },
    clearCommandStrip() {
      el.commandStrip.classList.add('hidden');
      el.commandStrip.innerHTML = '';
      state.activeCommandId = null;
    },
  };
}

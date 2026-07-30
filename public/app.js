// AGI-v1 frontend — vanilla JS, no build step.
// Auth, conversations, SSE chat streaming, people/memories, and the AGI Command
// centre (devices, commands, confirmations, workflows, voice).

import { createOrb } from './orb.js';
import { createVoice } from './voice.js';
import { createCommandCentre } from './agiCommand.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  user: null,
  conversations: [],
  currentConversationId: null,
  authMode: 'login',
  agiEnabled: false,
  streaming: false,
};

let orb = null;
let voice = null;
let centre = null;

// ---------- API helpers ----------
async function api(path, opts = {}) {
  // Only declare a JSON body when there actually is one: Fastify rejects a
  // request that claims application/json and then sends nothing, which is what
  // several of these endpoints do (pairing sessions, cancel, rotate).
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Assistant state (orb + text) ----------
const STATE_LABELS = {
  idle: 'Idle',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  confirming: 'Waiting for your confirmation',
  dispatching: 'Sending to devices',
  executing: 'Running on devices',
  speaking: 'Speaking',
  success: 'Done',
  partial: 'Partly done',
  error: 'Something went wrong',
};

function setState(next, detail = '') {
  orb?.setState(next);
  const label = $('#agi-state');
  if (label) label.textContent = STATE_LABELS[next] ?? next;
  const detailEl = $('#agi-detail');
  if (detailEl) detailEl.textContent = detail;
}

function notify(message) {
  const detail = $('#agi-detail');
  if (detail) detail.textContent = message;
}

// ---------- Auth ----------
async function tryAutoLogin() {
  try {
    const me = await api('/api/me');
    state.user = me;
    await showChat();
  } catch {
    showAuth();
  }
}

function showAuth() {
  $('#auth-view').classList.remove('hidden');
  $('#chat-view').classList.add('hidden');
}

async function showChat() {
  $('#auth-view').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#who').textContent = `@${state.user.username}`;

  if (!orb) orb = createOrb($('#orb'));
  setState('idle');

  if (!centre) {
    centre = createCommandCentre({ api, orb, voice: null, setState, notify });
  }
  const status = await centre.init();
  state.agiEnabled = Boolean(status?.enabled);

  if (!voice) {
    voice = createVoice({
      backend: status?.voice?.backend ?? 'browser',
      onTranscript: (text) => {
        $('#chat-input').value = text;
        hideInterim();
        // Send straight away: holding a button then pressing send twice is worse
        // than just acting on what was said.
        $('#chat-form').requestSubmit();
      },
      onInterim: showInterim,
      onState: (voiceState) => {
        if (voiceState === 'listening') setState('listening');
        else if (voiceState === 'transcribing') setState('transcribing');
        else if (voiceState === 'speaking') setState('speaking');
        else if (!state.streaming) setState('idle');
      },
      onError: (message) => {
        hideInterim();
        setState('idle', message);
      },
    });
    setupMic();
  }

  await refreshConversations();
  await refreshPeople();
  await refreshMemories();
}

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.authMode = btn.dataset.mode;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('#auth-form button.primary').textContent =
      state.authMode === 'login' ? 'Log in' : 'Create account';
    $('#display-name-label').classList.toggle('hidden', state.authMode !== 'register');
  });
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const username = $('#username').value.trim();
  const password = $('#password').value;
  const displayName = $('#display-name').value.trim();
  try {
    const endpoint = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const body =
      state.authMode === 'login'
        ? { username, password }
        : { username, password, displayName: displayName || undefined };
    const user = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
    state.user = user;
    await showChat();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.user = null;
  showAuth();
});

// ---------- Sidebar tabs ----------
const PANELS = {
  conversations: '#side-conversations',
  devices: '#side-devices',
  workflows: '#side-workflows',
  people: '#side-people',
  memories: '#side-memories',
};

$$('.side-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.side-tab').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    for (const [key, selector] of Object.entries(PANELS)) {
      $(selector).classList.toggle('hidden', key !== tab);
    }
    if (tab === 'people') refreshPeople();
    if (tab === 'memories') refreshMemories();
    if (tab === 'devices') centre?.refreshDevices();
    if (tab === 'workflows') centre?.refreshWorkflows();
  });
});

// ---------- Conversations ----------
async function refreshConversations() {
  try {
    state.conversations = await api('/api/conversations');
  } catch {
    state.conversations = [];
  }
  const list = $('#side-conversations');
  list.innerHTML = '';
  if (state.conversations.length === 0) {
    list.innerHTML = '<div class="empty-state">No chats yet. Start one →</div>';
    return;
  }
  for (const c of state.conversations) {
    const btn = document.createElement('button');
    btn.className = 'conv-item' + (c.id === state.currentConversationId ? ' active' : '');
    btn.textContent = c.title;
    btn.addEventListener('click', () => openConversation(c.id));
    list.appendChild(btn);
  }
}

async function openConversation(id) {
  state.currentConversationId = id;
  centre?.clearCommandStrip();
  $$('.conv-item').forEach((el) => el.classList.remove('active'));
  const messages = await api(`/api/conversations/${id}/messages`);
  const container = $('#messages');
  container.innerHTML = '';
  for (const m of messages) addBubble(m.role, m.content);
  container.scrollTop = container.scrollHeight;
  await refreshConversations();
}

$('#new-chat').addEventListener('click', async () => {
  const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
  state.conversations.unshift(c);
  await refreshConversations();
  openConversation(c.id);
});

// ---------- Messages ----------
function addBubble(role, content) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = content;
  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return div;
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  hideInterim();

  if (!state.currentConversationId) {
    const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
    state.currentConversationId = c.id;
    state.conversations.unshift(c);
    await refreshConversations();
  }

  addBubble('user', content);
  const assistant = addBubble('assistant', '');
  assistant.classList.add('thinking');
  state.streaming = true;
  setState('thinking');
  $('#stop-btn').classList.remove('hidden');

  let sawDeviceMeta = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        conversationId: state.currentConversationId,
        content,
        // Lets "on this device" resolve to the browser, when it is registered.
        thisDeviceId: centre?.getBrowserDeviceId() ?? undefined,
      }),
    });
    if (!res.ok) throw new Error(`Chat HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) assistant.textContent += parsed.token;
          else if (parsed.error) assistant.textContent += `\n[error: ${parsed.error}]`;
          else if (parsed.meta) {
            sawDeviceMeta = handleChatMeta(parsed.meta) || sawDeviceMeta;
          }
        } catch {
          /* ignore malformed frame */
        }
      }
    }
    assistant.classList.remove('thinking');
    state.streaming = false;
    $('#stop-btn').classList.add('hidden');

    // Speak the reply if spoken responses are on.
    voice?.speak(assistant.textContent);
    if (!sawDeviceMeta) setState('idle');

    await refreshPeople();
    await refreshMemories();
    await refreshConversations();
  } catch (err) {
    assistant.textContent = `[error: ${err.message}]`;
    assistant.classList.remove('thinking');
    state.streaming = false;
    $('#stop-btn').classList.add('hidden');
    setState('error', err.message);
  }
});

/** Reacts to the orchestrator's meta frame. Returns true if it was device work. */
function handleChatMeta(meta) {
  if (!meta || !meta.deviceTurn) return false;
  if (meta.agiCommand === 'confirmation_required') {
    setState('confirming');
    // The confirmation card itself arrives over the device stream.
    return true;
  }
  if (meta.commandId) {
    setState('executing');
    centre?.showCommand(meta.commandId);
    return true;
  }
  setState('idle');
  return true;
}

$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// ---------- Voice controls ----------
function showInterim(text) {
  const el = $('#voice-transcript');
  el.classList.remove('hidden');
  el.textContent = text;
}

function hideInterim() {
  const el = $('#voice-transcript');
  el.classList.add('hidden');
  el.textContent = '';
}

function setupMic() {
  const mic = $('#mic-btn');
  const stop = $('#stop-btn');

  if (!voice.sttAvailable) {
    mic.disabled = true;
    mic.title = 'Speech recognition is not available in this browser — type instead.';
  }

  let listening = false;
  const begin = () => {
    if (listening || mic.disabled) return;
    listening = true;
    mic.setAttribute('aria-pressed', 'true');
    mic.classList.add('active');
    voice.startListening();
  };
  const end = () => {
    if (!listening) return;
    listening = false;
    mic.setAttribute('aria-pressed', 'false');
    mic.classList.remove('active');
    voice.stopListening();
  };

  // Press and hold with a pointer…
  mic.addEventListener('pointerdown', begin);
  mic.addEventListener('pointerup', end);
  mic.addEventListener('pointerleave', end);
  // …or click once to start and again to stop, which is what keyboard and
  // screen-reader users get.
  mic.addEventListener('click', (e) => {
    // A pointer press already handled this.
    if (e.detail !== 0) return;
    if (listening) end();
    else begin();
  });
  mic.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (listening) end();
      else begin();
    }
  });

  stop.addEventListener('click', () => {
    voice.stopSpeaking();
    end();
    setState('idle');
  });
}

// ---------- Devices panel actions ----------
$('#pair-device').addEventListener('click', () => centre?.startPairing());
$('#register-browser').addEventListener('click', () => centre?.registerBrowserDevice());

// ---------- Workflow editor ----------
const workflowModal = {
  open() {
    $('#workflow-modal').classList.remove('hidden');
    $('#workflow-name').value = '';
    $('#workflow-description').value = '';
    $('#workflow-error').textContent = '';
    $('#workflow-steps').innerHTML = '';
    this.addStep();
    $('#workflow-name').focus();
  },
  close() {
    $('#workflow-modal').classList.add('hidden');
  },
  addStep() {
    const container = $('#workflow-steps');
    const row = document.createElement('div');
    row.className = 'workflow-step-row';

    const capability = document.createElement('select');
    capability.className = 'step-capability';
    for (const cap of centre?.state.capabilities ?? []) {
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

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost-btn danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => row.remove());
    row.appendChild(remove);

    container.appendChild(row);
  },
  collect() {
    return $$('#workflow-steps .workflow-step-row').map((row) => {
      const capability = row.querySelector('.step-capability').value;
      const targetText = row.querySelector('.step-target').value.trim();
      const paramsText = row.querySelector('.step-params').value.trim();
      let parameters = {};
      if (paramsText) parameters = JSON.parse(paramsText);
      // A bare word is treated as a group if it looks like one, else a device.
      const targetExpression = targetText
        ? /^(phones|tablets|computers|browsers|all)$/i.test(targetText)
          ? { includeGroups: [targetText.toLowerCase()] }
          : { includeDeviceNames: [targetText] }
        : {};
      return { capability, parameters, targetExpression };
    });
  },
};

$('#new-workflow').addEventListener('click', () => workflowModal.open());
$('#add-step').addEventListener('click', () => workflowModal.addStep());
$('#workflow-cancel').addEventListener('click', () => workflowModal.close());
$('#workflow-modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') workflowModal.close();
});
$('#workflow-save').addEventListener('click', async () => {
  const errorEl = $('#workflow-error');
  errorEl.textContent = '';
  try {
    const steps = workflowModal.collect();
    if (steps.length === 0) throw new Error('Add at least one step.');
    await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#workflow-name').value.trim(),
        description: $('#workflow-description').value.trim() || null,
        steps,
      }),
    });
    workflowModal.close();
    await centre?.refreshWorkflows();
  } catch (err) {
    errorEl.textContent =
      err instanceof SyntaxError ? 'Parameters must be valid JSON.' : err.message;
  }
});

// ---------- People & Memories ----------
async function refreshPeople() {
  try {
    const people = await api('/api/people');
    const list = $('#side-people');
    list.innerHTML = '';
    if (!people || people.length === 0) {
      list.innerHTML = '<div class="empty-state">No people tracked yet.</div>';
      return;
    }
    for (const p of people) {
      const btn = document.createElement('button');
      btn.className = 'person-item';
      btn.innerHTML = `${p.displayName}<span class="rel">${p.relationship || 'unknown'} · ${p.mentionCount} mentions</span>`;
      list.appendChild(btn);
    }
  } catch {
    /* people route unavailable */
  }
}

async function refreshMemories() {
  try {
    const memories = await api('/api/memories?limit=40');
    const list = $('#side-memories');
    list.innerHTML = '';
    if (!memories || memories.length === 0) {
      list.innerHTML = '<div class="empty-state">No memories yet.</div>';
      return;
    }
    for (const m of memories) {
      const item = document.createElement('div');
      item.className = 'memory-item';
      item.innerHTML = `<span class="kind">${m.kind}</span>${m.content}`;
      list.appendChild(item);
    }
  } catch {
    /* memories route unavailable */
  }
}

// Go
tryAutoLogin();

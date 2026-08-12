import { parseMessageSegments } from './messageLinks.js';
import { createOrb } from './orb.js';
import { createVoice } from './voice.js';
import { createCommandCentre } from './agiCommand.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  user: null,
  conversations: [],
  currentConversationId: null,
  conversationLoadRequest: 0,
  authMode: 'login',
  memories: [],
  capabilities: [],
  latestSources: [],
  activePanel: 'chats',
  callMode: false,
  sending: false,
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500);
}

function setActiveNav(panel) {
  state.activePanel = panel;
  $$('[data-panel]').forEach((button) => {
    if (!button.matches('.nav-item, .mobile-nav-item')) return;
    button.classList.toggle('active', button.dataset.panel === panel);
  });
}

function setHomeMode(enabled) {
  $('#chat-view').classList.toggle('home-mode', enabled);
  $('#home-screen').classList.toggle('hidden', !enabled);
  $('#conversation-screen').classList.toggle('hidden', enabled);
  if (enabled) $('#chat-input').placeholder = 'Ask me anything…';
  else $('#chat-input').placeholder = 'Message AGI-v1…';
}

function showAuth(message = '') {
  $('#auth-view').classList.remove('hidden');
  $('#chat-view').classList.add('hidden');
  if (message) $('#auth-error').textContent = message;
}

async function showChat() {
  $('#auth-view').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#profile-name').textContent = state.user.displayName || `@${state.user.username}`;
  $('#profile-avatar').textContent = (state.user.displayName || state.user.username || 'A')
    .slice(0, 1)
    .toUpperCase();
  state.currentConversationId = null;
  state.conversationLoadRequest += 1;
  $('#messages').innerHTML = '';
  setHomeMode(true);
  setActiveNav('chats');
  await Promise.all([
    refreshConversations(),
    refreshMemories(),
    refreshCapabilities(),
    initAgiCommand(),
  ]);
}

async function tryAutoLogin() {
  try {
    state.user = await api('/api/me');
    await showChat();
  } catch {
    showAuth();
  }
}

function syncAuthMode() {
  const registering = state.authMode === 'register';
  const password = $('#password');
  $('.submit-label').textContent = registering ? 'Create account' : 'Log in';
  $('#auth-title').textContent = registering ? 'Create your account' : 'Welcome back';
  $('#auth-subtitle').textContent = registering
    ? 'Start a private workspace that remembers what matters.'
    : 'Log in to continue your conversations.';
  $('#display-name-label').classList.toggle('hidden', !registering);
  $('#password-help').classList.toggle('hidden', !registering);
  password.autocomplete = registering ? 'new-password' : 'current-password';
  if (registering) {
    // Kept in step with the server rule in src/http/routes/auth.ts.
    password.minLength = 4;
    password.removeAttribute('pattern');
    password.title = 'At least 4 characters.';
  } else {
    password.removeAttribute('minlength');
    password.removeAttribute('pattern');
    password.removeAttribute('title');
  }
}

$$('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.authMode = button.dataset.mode;
    $$('.tab').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $('#auth-error').textContent = '';
    syncAuthMode();
  });
});

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  const submit = $('.auth-submit');
  submit.disabled = true;
  try {
    const registering = state.authMode === 'register';
    const body = {
      username: $('#username').value.trim(),
      password: $('#password').value,
      ...(registering && $('#display-name').value.trim()
        ? { displayName: $('#display-name').value.trim() }
        : {}),
    };
    state.user = await api(registering ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await showChat();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  state.user = null;
  state.conversations = [];
  state.memories = [];
  state.capabilities = [];
  state.currentConversationId = null;
  $('#profile-menu').classList.add('hidden');
  showAuth();
});

$('#profile-button').addEventListener('click', () => {
  const menu = $('#profile-menu');
  const open = menu.classList.toggle('hidden') === false;
  $('#profile-button').setAttribute('aria-expanded', String(open));
});

$('#sidebar-collapse').addEventListener('click', () => {
  $('#chat-view').classList.toggle('sidebar-collapsed');
});

function renderConversations() {
  const list = $('#side-conversations');
  list.innerHTML = '';
  if (state.conversations.length === 0) {
    list.innerHTML = '<div class="empty-state">Your conversations will appear here.</div>';
    return;
  }

  for (const conversation of state.conversations.slice(0, 16)) {
    const row = document.createElement('div');
    row.className = 'conv-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = `conv-item${conversation.id === state.currentConversationId ? ' active' : ''}`;
    open.textContent = conversation.title || 'New chat';
    open.title = conversation.title || 'New chat';
    open.addEventListener('click', () => openConversation(conversation.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'conv-menu';
    remove.title = 'Delete chat';
    remove.setAttribute('aria-label', `Delete ${conversation.title || 'chat'}`);
    remove.innerHTML = '<span class="material-symbols-rounded">delete</span>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!window.confirm('Delete this conversation?')) return;
      try {
        await api(`/api/conversations/${conversation.id}`, { method: 'DELETE' });
        if (state.currentConversationId === conversation.id) {
          state.currentConversationId = null;
          $('#messages').innerHTML = '';
          setHomeMode(true);
        }
        await refreshConversations();
      } catch (error) {
        showToast(error.message);
      }
    });

    row.append(open, remove);
    list.appendChild(row);
  }
}

async function refreshConversations() {
  try {
    state.conversations = await api('/api/conversations');
  } catch {
    state.conversations = [];
  }
  if (
    state.currentConversationId &&
    !state.conversations.some((conversation) => conversation.id === state.currentConversationId)
  ) {
    state.currentConversationId = null;
    setHomeMode(true);
  }
  renderConversations();
}

function renderMessageContent(element, content) {
  element.textContent = '';
  for (const segment of parseMessageSegments(content)) {
    if (!segment.url) {
      element.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const link = document.createElement('a');
    link.href = segment.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = segment.text;
    element.appendChild(link);
  }
}

function collectSources(content) {
  const sources = [];
  const seen = new Set();
  for (const segment of parseMessageSegments(content)) {
    if (!segment.url || seen.has(segment.url)) continue;
    seen.add(segment.url);
    const url = new URL(segment.url);
    sources.push({
      url: segment.url,
      label: segment.text === segment.url ? url.hostname : segment.text,
      host: url.hostname.replace(/^www\./, ''),
    });
  }
  return sources;
}

function addBubble(role, content) {
  const row = document.createElement('div');
  row.className = `message-row ${role}`;

  if (role === 'assistant') {
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.innerHTML = '<span class="material-symbols-rounded">neurology</span>';
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  renderMessageContent(bubble, content);
  row.appendChild(bubble);
  $('#messages').appendChild(row);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return bubble;
}

async function openConversation(id) {
  const requestId = ++state.conversationLoadRequest;
  state.currentConversationId = id;
  setActiveNav('chats');
  closePanel();
  setHomeMode(false);
  renderConversations();
  const conversation = state.conversations.find((item) => item.id === id);
  $('#conversation-title').textContent = conversation?.title || 'Conversation';
  $('#messages').innerHTML = '<div class="empty-state">Loading conversation…</div>';

  try {
    const messages = await api(`/api/conversations/${id}/messages`);
    if (requestId !== state.conversationLoadRequest || id !== state.currentConversationId) return;
    $('#messages').innerHTML = '';
    state.latestSources = [];
    for (const message of messages) {
      addBubble(message.role, message.content);
      if (message.role === 'assistant') {
        const sources = collectSources(message.content);
        if (sources.length > 0) state.latestSources = sources;
      }
    }
    renderContext();
  } catch (error) {
    if (requestId !== state.conversationLoadRequest) return;
    $('#messages').innerHTML = `<div class="empty-state">Could not load this conversation: ${escapeHtml(error.message)}</div>`;
  }
}

$('#new-chat').addEventListener('click', () => {
  state.currentConversationId = null;
  state.conversationLoadRequest += 1;
  state.latestSources = [];
  $('#messages').innerHTML = '';
  $('#chat-input').value = '';
  closePanel();
  setActiveNav('chats');
  setHomeMode(true);
  renderConversations();
  renderContext();
  $('#chat-input').focus();
});

$$('.starter-card').forEach((button) => {
  button.addEventListener('click', () => {
    $('#chat-input').value = button.dataset.prompt || '';
    autoSizeComposer();
    $('#chat-input').focus();
  });
});

function durableMemories() {
  const seen = new Set();
  return state.memories.filter((memory) => {
    if (memory.kind === 'raw_turn') return false;
    const key = `${memory.kind}:${memory.content.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function memoryLabel(memory) {
  if (memory.kind === 'summary') return 'Summary';
  if (/\bprefer|favorite|style|tone\b/i.test(memory.content)) return 'Preference';
  return 'Remembered fact';
}

function renderContext() {
  const sourceList = $('#source-list');
  const sources = state.latestSources.slice(0, 5);
  $('#source-count').textContent = String(sources.length);
  sourceList.innerHTML = '';
  if (sources.length === 0) {
    sourceList.innerHTML = '<div class="drawer-empty">Sources from the latest web answer will appear here.</div>';
  } else {
    for (const source of sources) {
      const link = document.createElement('a');
      link.className = 'source-card';
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.innerHTML = `<span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.host)}</small></span><span class="material-symbols-rounded">open_in_new</span>`;
      sourceList.appendChild(link);
    }
  }

  const memories = durableMemories().slice(0, 4);
  $('#memory-count').textContent = String(memories.length);
  const memoryList = $('#drawer-memories');
  memoryList.innerHTML = '';
  if (memories.length === 0) {
    memoryList.innerHTML = '<div class="drawer-empty">Useful details you ask me to remember will appear here.</div>';
  } else {
    for (const memory of memories) {
      const card = document.createElement('article');
      card.className = 'memory-card';
      card.innerHTML = `<span class="memory-kind">${escapeHtml(memoryLabel(memory))}</span><p>${escapeHtml(memory.content)}</p>`;
      memoryList.appendChild(card);
    }
  }
}

async function refreshMemories() {
  try {
    state.memories = await api('/api/memories?limit=100');
  } catch {
    state.memories = [];
  }
  renderContext();
  if (state.activePanel === 'memories') renderMemoryPanel();
}

async function refreshCapabilities() {
  try {
    state.capabilities = await api('/api/capabilities');
  } catch {
    state.capabilities = [];
  }
  const latest = state.capabilities[0];
  const label = $('.capability-activity span:nth-child(2)');
  if (label) {
    if (!latest) label.textContent = 'Capability activity';
    else if (['pending', 'generating', 'validating'].includes(latest.status)) label.textContent = 'Capability in progress';
    else if (latest.status === 'pr_opened') label.textContent = 'Draft PR ready';
    else label.textContent = 'Capability activity';
  }
  if (state.activePanel === 'capabilities') renderCapabilitiesPanel();
}

function openContext() {
  $('#chat-view').classList.remove('context-closed');
  $('#context-toggle').setAttribute('aria-expanded', 'true');
  $('#drawer-scrim').classList.remove('hidden');
}

function closeContext() {
  $('#chat-view').classList.add('context-closed');
  $('#context-toggle').setAttribute('aria-expanded', 'false');
  $('#drawer-scrim').classList.add('hidden');
}

$('#context-toggle').addEventListener('click', () => {
  if ($('#chat-view').classList.contains('context-closed')) openContext();
  else closeContext();
});
$('#home-context-toggle').addEventListener('click', openContext);
$('#mobile-context-toggle').addEventListener('click', openContext);
$('#context-close').addEventListener('click', closeContext);
$('#drawer-scrim').addEventListener('click', closeContext);

function closePanel() {
  $('#panel-view').classList.add('hidden');
}

function openPanel(panel) {
  if (panel === 'chats') {
    setActiveNav('chats');
    closePanel();
    if (state.currentConversationId) setHomeMode(false);
    else setHomeMode(true);
    return;
  }

  setActiveNav(panel);
  $('#panel-view').classList.remove('hidden');
  if (panel === 'memories') {
    $('#panel-eyebrow').textContent = 'Your context';
    $('#panel-title').textContent = 'Memories';
    $('#panel-subtitle').textContent = 'Useful details you have shared. Raw chat history stays out of this view.';
    renderMemoryPanel();
  } else if (panel === 'devices') {
    $('#panel-eyebrow').textContent = 'AGI Command';
    $('#panel-title').textContent = 'Devices';
    $('#panel-subtitle').textContent =
      'Devices you have paired, what each one can do, and whether it is reachable right now.';
    commandCentre?.renderDevicePanel();
    void commandCentre?.refreshDevices();
  } else if (panel === 'flows') {
    $('#panel-eyebrow').textContent = 'AGI Command';
    $('#panel-title').textContent = 'Workflows';
    $('#panel-subtitle').textContent =
      'Reusable multi-device routines. Every step is an approved action, not a script, and a run asks once before it starts.';
    commandCentre?.renderWorkflowPanel();
    void commandCentre?.refreshWorkflows();
  } else {
    $('#panel-eyebrow').textContent = 'Safe self-improvement';
    $('#panel-title').textContent = 'Capabilities';
    $('#panel-subtitle').textContent = 'New tools are tested in a sandbox and opened as draft pull requests for human review.';
    renderCapabilitiesPanel();
  }
}

$$('[data-panel]').forEach((button) => {
  if (button.matches('.starter-card')) return;
  button.addEventListener('click', () => openPanel(button.dataset.panel));
});
$('#panel-close').addEventListener('click', () => openPanel('chats'));
$('#mobile-back').addEventListener('click', () => {
  state.currentConversationId = null;
  setHomeMode(true);
  renderConversations();
});

function renderMemoryPanel() {
  const content = $('#panel-content');
  const memories = durableMemories();
  if (memories.length === 0) {
    content.innerHTML = `
      <div class="panel-empty"><div>
        <span class="material-symbols-rounded">bookmark</span>
        <h3>No durable memories yet</h3>
        <p>Tell AGI-v1 to remember a preference, project detail, or other useful fact.</p>
      </div></div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  for (const memory of memories) {
    const card = document.createElement('article');
    card.className = 'panel-card';
    card.innerHTML = `
      <div class="panel-card-head">
        <div><span class="memory-kind">${escapeHtml(memoryLabel(memory))}</span><h3>${escapeHtml(memory.content)}</h3></div>
      </div>
      <p>Saved ${formatDate(memory.createdAt)}</p>
      <div class="panel-card-actions">
        <button class="danger" type="button"><span class="material-symbols-rounded">delete</span>Forget</button>
      </div>`;
    card.querySelector('button').addEventListener('click', async () => {
      try {
        await api(`/api/memories/${memory.id}`, { method: 'DELETE' });
        state.memories = state.memories.filter((item) => item.id !== memory.id);
        renderMemoryPanel();
        renderContext();
        showToast('Memory forgotten.');
      } catch (error) {
        showToast(error.message);
      }
    });
    grid.appendChild(card);
  }
  content.replaceChildren(grid);
}

function renderCapabilitiesPanel() {
  const content = $('#panel-content');
  if (state.capabilities.length === 0) {
    content.innerHTML = `
      <div class="panel-empty"><div>
        <span class="material-symbols-rounded">code</span>
        <h3>No capability activity yet</h3>
        <p>If a safe task needs a missing tool, AGI-v1 can propose one as a tested draft PR.</p>
      </div></div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  for (const capability of state.capabilities) {
    const card = document.createElement('article');
    const statusClass = capability.status === 'failed' ? ' failed' : '';
    const status = capability.status.replaceAll('_', ' ');
    card.className = 'panel-card';
    card.innerHTML = `
      <div class="panel-card-head">
        <h3>${escapeHtml(capability.task.replace(/^\[self-improvement\]\s*/i, ''))}</h3>
        <span class="status-pill${statusClass}">${escapeHtml(status)}</span>
      </div>
      <p>${escapeHtml(capabilityStatusCopy(capability))}</p>
      ${capability.pr_url
        ? `<a href="${escapeHtml(capability.pr_url)}" target="_blank" rel="noopener noreferrer">Open draft PR <span class="material-symbols-rounded">open_in_new</span></a>`
        : ''}`;
    grid.appendChild(card);
  }
  content.replaceChildren(grid);
}

function capabilityStatusCopy(capability) {
  if (capability.status === 'pr_opened') return 'Sandbox checks completed. The draft is waiting for human review.';
  if (capability.status === 'validating') return 'Running generated and independent tests in an isolated sandbox.';
  if (capability.status === 'generating') return 'Drafting the implementation and its test suite.';
  if (capability.status === 'pending') return 'Queued to begin safely.';
  return capability.error || 'The capability could not be completed.';
}

function formatDate(value) {
  if (!value) return 'recently';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function autoSizeComposer() {
  const input = $('#chat-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

$('#chat-input').addEventListener('input', autoSizeComposer);
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.sending) return;
  const input = $('#chat-input');
  const content = input.value.trim();
  if (!content) return;

  state.sending = true;
  $('.send-button').disabled = true;
  input.value = '';
  autoSizeComposer();

  try {
    if (!state.currentConversationId) {
      const conversation = await api('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      state.currentConversationId = conversation.id;
      state.conversations.unshift(conversation);
      $('#conversation-title').textContent = content.split('\n')[0].slice(0, 60);
      setHomeMode(false);
      renderConversations();
    }

    addBubble('user', content);
    const assistant = addBubble('assistant', '');
    assistant.classList.add('thinking');
    let assistantText = '';
    let sawDeviceTurn = false;
    setAgiState('thinking');

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        conversationId: state.currentConversationId,
        content,
        // Lets "on this device" resolve to the browser, when it is registered.
        thisDeviceId: commandCentre?.getBrowserDeviceId() ?? undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showAuth('Your session expired. Log in again to continue.');
        return;
      }
      throw new Error(body.message || body.error || `Chat failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split(/\r?\n/).find((item) => item.startsWith('data: '));
        if (!line) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          const data = JSON.parse(raw);
          if (data.token) {
            assistantText += data.token;
            assistant.textContent = assistantText;
          } else if (data.error) {
            throw new Error(data.error);
          } else if (data.meta?.capabilityRecovery === 'started') {
            showToast('A missing capability was detected. Safe generation has started.');
          } else if (data.meta?.capabilityRecovery === 'completed') {
            showToast('Capability draft is ready for human review.');
          } else if (data.meta?.deviceTurn) {
            sawDeviceTurn = handleDeviceMeta(data.meta) || sawDeviceTurn;
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }

    if (!assistantText.trim()) throw new Error('The model returned no text. Please try again.');
    renderMessageContent(assistant, assistantText);
    assistant.classList.remove('thinking');
    // In call mode, listening resumes only once the reply has finished playing,
    // otherwise the microphone picks up the assistant and answers itself.
    voice?.speak(assistantText, continueCall);
    // A device turn sets its own state from real command results.
    if (!sawDeviceTurn) setAgiState('idle');
    state.latestSources = collectSources(assistantText);
    renderContext();
    await Promise.all([
      refreshConversations(),
      refreshMemories(),
      refreshCapabilities(),
    ]);
  } catch (error) {
    const thinking = $('.bubble.assistant.thinking');
    if (thinking) {
      thinking.classList.remove('thinking');
      thinking.textContent = `I couldn’t complete that reply. ${error.message}`;
    }
    showToast('The reply failed. Your message is still saved, so you can retry.');
    setAgiState('error', error.message);
    // Do not keep a call looping against a failing turn.
    endCall();
  } finally {
    state.sending = false;
    $('.send-button').disabled = false;
    input.focus();
  }
});

// ---------------------------------------------------------------------------
// AGI Command
//
// Additive: when the server reports the feature off, none of this is shown and
// the rest of AGI-v1 behaves exactly as before.
// ---------------------------------------------------------------------------

let orb = null;
let voice = null;
let commandCentre = null;
let micControls = null;
let callResumeTimer = null;

const AGI_STATE_LABELS = {
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

function setAgiState(next, detail = '') {
  orb?.setState(next);
  const label = $('#agi-state');
  if (label) label.textContent = detail || AGI_STATE_LABELS[next] || next;
}

/** Reacts to the orchestrator's meta frame. Returns true if it was device work. */
function handleDeviceMeta(meta) {
  if (meta.agiCommand === 'confirmation_required') {
    setAgiState('confirming');
    // The confirmation card itself arrives over the device stream.
    return true;
  }
  if (meta.commandId) {
    setAgiState('executing');
    commandCentre?.showCommand(meta.commandId);
    return true;
  }
  setAgiState('idle');
  return true;
}

/**
 * Voice is a chat feature, not a device feature. It is set up whenever the
 * browser supports it, regardless of whether AGI Command is enabled — gating it
 * behind device control meant the microphone never appeared on deployments with
 * the feature switched off.
 */
function initVoice(backendName = 'browser') {
  if (voice) return;

  voice = createVoice({
    backend: backendName,
    onTranscript: (text) => {
      $('#chat-input').value = text;
      hideInterim();
      // Send straight away: holding a button and then pressing send is worse
      // than just acting on what was said.
      $('#chat-form').requestSubmit();
    },
    onInterim: showInterim,
    onState: (voiceState) => {
      if (voiceState === 'listening') setAgiState('listening');
      else if (voiceState === 'transcribing') setAgiState('transcribing');
      else if (voiceState === 'speaking') setAgiState('speaking');
      else if (!state.sending) setAgiState('idle');
    },
    onError: (message) => {
      hideInterim();
      setAgiState('idle');
      // A refused microphone in call mode must not leave it looping.
      endCall();
      syncWakeButton();
      showToast(message);
    },
    // Fired when the wake phrase is heard: capture the actual command next.
    onWake: () => {
      setAgiState('listening', 'Wake word heard — go ahead');
      micControls?.begin();
    },
  });

  if (!orb) orb = createOrb($('#orb'));
  // Show the presence when there is any voice to reflect, even with devices off.
  if (voice.sttAvailable || voice.ttsAvailable) {
    $('#agi-presence')?.classList.remove('hidden');
  }
  setAgiState('idle');
  setupMic();
}

async function initAgiCommand() {
  if (!commandCentre) {
    commandCentre = createCommandCentre({ api, orb: null, setState: setAgiState, showToast });
  }
  const status = await commandCentre.init();
  // Voice is set up either way; the status call only supplies the backend name.
  initVoice(status?.voice?.backend ?? 'browser');
}

function showInterim(text) {
  const node = $('#voice-transcript');
  if (!node) return;
  node.classList.remove('hidden');
  node.textContent = text;
}

function hideInterim() {
  const node = $('#voice-transcript');
  if (!node) return;
  node.classList.add('hidden');
  node.textContent = '';
}

function setupMic() {
  const mic = $('#mic-btn');
  const stop = $('#stop-btn');
  const call = $('#call-btn');
  if (!mic || !stop || !call) return;

  mic.classList.remove('hidden');
  if (!voice.sttAvailable) {
    mic.disabled = true;
    mic.title =
      'Speech recognition is not available in this browser. Chrome or Edge support it; Firefox does not. You can still type.';
    call.disabled = true;
    call.title = mic.title;
  }
  if (voice.sttAvailable) call.classList.remove('hidden');
  if (voice.ttsAvailable) stop.classList.remove('hidden');

  const wake = $('#wake-btn');
  if (wake && voice.wakeAvailable) {
    wake.classList.remove('hidden');
    wake.addEventListener('click', toggleWakeWord);
    // Restore the user's previous choice, but never silently: enabling the wake
    // word opens the microphone, so it is only restored if they turned it on.
    if (localStorage.getItem(WAKE_STORAGE_KEY) === 'on') toggleWakeWord(true);
  }

  let listening = false;
  const begin = () => {
    if (listening || mic.disabled) return;
    listening = true;
    mic.setAttribute('aria-pressed', 'true');
    mic.classList.add('active');
    // Only one recogniser may hold the microphone at a time.
    voice.pauseWake();
    voice.startListening();
  };
  const end = () => {
    if (!listening) return;
    listening = false;
    mic.setAttribute('aria-pressed', 'false');
    mic.classList.remove('active');
    voice.stopListening();
  };

  // Exposed so the call loop can drive the same primitives the button does.
  micControls = { begin, end };

  call.addEventListener('click', () => {
    if (state.callMode) endCall();
    else startCall();
  });

  // Press and hold with a pointer…
  mic.addEventListener('pointerdown', begin);
  mic.addEventListener('pointerup', end);
  mic.addEventListener('pointerleave', end);
  // …or click once to start and again to stop, which is what keyboard and
  // screen-reader users get.
  mic.addEventListener('click', (event) => {
    if (event.detail !== 0) return; // a pointer press already handled this
    if (listening) end();
    else begin();
  });
  mic.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (listening) end();
      else begin();
    }
  });

  stop.addEventListener('click', () => {
    voice.stopSpeaking();
    end();
    // Stop means stop: it ends the call and the wake listener too, not just the
    // current sentence. One obvious control that closes the microphone.
    endCall();
    if (voice.isWakeActive()) toggleWakeWord(false);
    setAgiState('idle');
  });
}

// ---------------------------------------------------------------------------
// Call mode — hands-free conversation.
//
// Explicitly started by pressing Call and visibly active the whole time. This
// is not a wake word and not always-listening: nothing records until you press
// the button, and pressing it again (or Stop) ends it.
//
// The loop is listen -> send -> speak -> listen. It waits for playback to
// finish before listening again, otherwise the microphone hears the reply and
// talks to itself.
// ---------------------------------------------------------------------------

function startCall() {
  if (!voice?.sttAvailable) {
    showToast('This browser cannot do speech recognition. Chrome or Edge can.');
    return;
  }
  state.callMode = true;
  const call = $('#call-btn');
  call?.classList.add('active');
  call?.setAttribute('aria-pressed', 'true');
  if (call) call.title = 'End the voice conversation';
  showToast('Voice call started. Speak when you see "Listening". Press Call again to end.');
  micControls?.begin();
}

function endCall() {
  if (!state.callMode) return;
  state.callMode = false;
  const call = $('#call-btn');
  call?.classList.remove('active');
  call?.setAttribute('aria-pressed', 'false');
  if (call) call.title = 'Start a hands-free voice conversation';
  micControls?.end();
  clearTimeout(callResumeTimer);
}

/** Called once a reply has finished being spoken. */
function continueCall() {
  if (state.callMode) {
    // A short pause so the tail of the reply is not captured as user speech.
    callResumeTimer = setTimeout(() => {
      if (state.callMode) micControls?.begin();
    }, 400);
    return;
  }
  // Outside a call, hand the microphone back to the wake listener.
  voice?.resumeWake();
}

// ---------------------------------------------------------------------------
// Wake word
//
// Off by default and never enabled silently. While it is on the microphone is
// genuinely open and continuously processing — that is the honest description,
// and the button says so. Nothing is stored and nothing reaches AGI-v1 until
// the phrase is heard, but the audio is going to the browser vendor's
// recogniser the whole time. See docs/voice-architecture.md.
// ---------------------------------------------------------------------------

const WAKE_STORAGE_KEY = 'agi-v1.wakeWord';
const WAKE_PHRASES = ['hey agi', 'ok agi', 'agi v1', 'hey jarvis'];

function toggleWakeWord(forceOn) {
  if (!voice?.wakeAvailable) {
    showToast('This browser cannot do speech recognition, so there is no wake word.');
    return;
  }
  const turningOn = forceOn === true ? true : !voice.isWakeActive();
  const active = voice.setWakeWord(turningOn, WAKE_PHRASES);

  localStorage.setItem(WAKE_STORAGE_KEY, active ? 'on' : 'off');
  syncWakeButton();

  if (active) {
    showToast(`Wake word on — say "${WAKE_PHRASES[0]}". The microphone stays open until you turn this off.`);
  } else if (forceOn !== true) {
    showToast('Wake word off. The microphone is closed.');
  }
}

function syncWakeButton() {
  const wake = $('#wake-btn');
  if (!wake || !voice) return;
  const active = voice.isWakeActive();
  wake.classList.toggle('active', active);
  wake.setAttribute('aria-pressed', String(active));
  wake.title = active
    ? `Listening for "${WAKE_PHRASES[0]}". The microphone is open — click to stop.`
    : 'Listen for a wake word. While this is on, the microphone stays open.';
}

syncAuthMode();
closeContext();
tryAutoLogin();

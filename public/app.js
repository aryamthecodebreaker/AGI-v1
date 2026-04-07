// AGI-v1 frontend — vanilla JS, no build step.
// Handles auth, conversation list, SSE chat streaming, people/memories tabs.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  user: null,
  conversations: [],
  currentConversationId: null,
  authMode: 'login',
};

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Auth ----------
async function tryAutoLogin() {
  try {
    const me = await api('/api/me');
    state.user = me;
    showChat();
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
  await refreshConversations();
  await refreshPeople();
  await refreshMemories();
}

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.authMode = btn.dataset.mode;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('#auth-form button.primary').textContent = state.authMode === 'login' ? 'Log in' : 'Create account';
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
    const body = state.authMode === 'login'
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
$$('.side-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.side-tab').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $('#side-conversations').classList.toggle('hidden', tab !== 'conversations');
    $('#side-people').classList.toggle('hidden', tab !== 'people');
    $('#side-memories').classList.toggle('hidden', tab !== 'memories');
    if (tab === 'people') refreshPeople();
    if (tab === 'memories') refreshMemories();
  });
});

// ---------- Conversations ----------
async function refreshConversations() {
  try {
    state.conversations = await api('/api/conversations');
  } catch { state.conversations = []; }
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

  // Ensure a conversation exists.
  if (!state.currentConversationId) {
    const c = await api('/api/conversations', { method: 'POST', body: JSON.stringify({}) });
    state.currentConversationId = c.id;
    state.conversations.unshift(c);
    await refreshConversations();
  }

  addBubble('user', content);
  const assistant = addBubble('assistant', '');
  assistant.classList.add('thinking');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ conversationId: state.currentConversationId, content }),
    });
    if (!res.ok) throw new Error(`Chat HTTP ${res.status}`);

    // Read SSE stream
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
        } catch { /* ignore malformed frame */ }
      }
    }
    assistant.classList.remove('thinking');
    await refreshPeople();
    await refreshMemories();
    await refreshConversations();
  } catch (err) {
    assistant.textContent = `[error: ${err.message}]`;
    assistant.classList.remove('thinking');
  }
});

$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

// ---------- People & Memories (populated by later steps) ----------
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
  } catch { /* people route not wired yet */ }
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
  } catch { /* memories route not wired yet */ }
}

// Go
tryAutoLogin();

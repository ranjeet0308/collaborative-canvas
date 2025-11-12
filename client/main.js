// client/main.js
import { createCanvasSystem } from './canvas.js';

const params = new URLSearchParams(location.search);
const ROOM_ID = params.get('room') || 'main';

// DOM refs
const wrap = document.getElementById('canvasWrap');
const canvas = document.getElementById('canvas');
const colorInp = document.getElementById('color');
const widthInp = document.getElementById('width');
const brushBtn = document.getElementById('brushBtn');
const eraserBtn = document.getElementById('eraserBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const clearLocalBtn = document.getElementById('clearLocalBtn');
const voteClearBtn = document.getElementById('voteClearBtn');
const usersDiv = document.getElementById('users');

// Canvas system
const cs = createCanvasSystem({ canvas, wrap });
cs.resize();
window.addEventListener('resize', cs.resize);

// Socket.IO connection
const socket = io({ query: { room: ROOM_ID } });

// Client state
let myId = null;
let myColor = '#222222';
let brush = { color: '#222222', width: 4, mode: 'brush' };
let votedSet = new Set(); // track voteIds responded to
let activeVoteId = null;

// UI handlers
colorInp.oninput = () => { brush.color = colorInp.value; };
widthInp.oninput = () => { brush.width = +widthInp.value; };
brushBtn.onclick = () => { brush.mode = 'brush'; brushBtn.classList.add('primary'); eraserBtn.classList.remove('primary'); };
eraserBtn.onclick = () => { brush.mode = 'eraser'; eraserBtn.classList.add('primary'); brushBtn.classList.remove('primary'); };
undoBtn.onclick = () => socket.emit('client:undo');
redoBtn.onclick = () => socket.emit('client:redo');
clearLocalBtn.onclick = () => { const g = canvas.getContext('2d'); g.clearRect(0,0,canvas.width,canvas.height); cs.fullReplay(); };
voteClearBtn.onclick = () => socket.emit('client:clear_all_request');

// helper to render users list (simple)
function renderUsers(users) {
  usersDiv.innerHTML = '';
  for (const id of users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const dot = document.createElement('div'); dot.className = 'dot'; dot.style.background = (id === myId ? myColor : '#999');
    const name = document.createElement('div'); name.textContent = id.slice(0,4);
    row.appendChild(dot); row.appendChild(name);
    usersDiv.appendChild(row);
  }
}

// Socket events
socket.on('connect', () => {
  myId = socket.id;
  console.log('connected', myId);
});

socket.on('server:snapshot', (snap) => {
  cs.setOpLog(snap.ops || []);
  // build users array from snapshot (snap.users may be ids or objects)
  const userIds = (snap.users || []).map(u => typeof u === 'string' ? u : u.id);
  renderUsers(userIds);
  // color sent in snapshot (if server provides)
  if (snap.color) { myColor = snap.color; colorInp.value = myColor; brush.color = myColor; }
});

socket.on('server:op', (op) => {
  cs.applyOp(op);
});

socket.on('server:undo_group', ({ groupId }) => {
  for (const op of cs.getOpLog()) if (op.data?.groupId === groupId) op.tombstone = true;
  cs.fullReplay();
});

socket.on('server:redo_group', ({ groupId }) => {
  for (const op of cs.getOpLog()) if (op.data?.groupId === groupId) op.tombstone = false;
  cs.fullReplay();
});

socket.on('server:user_joined', (u) => {
  // u may be id or {id,color}
  const id = typeof u === 'string' ? u : u.id;
  // simple local users list rebuild
  const existing = Array.from((cs.getOpLog().__users || []) );
  existing.push(id);
  renderUsers(existing);
});
socket.on('server:user_left', ({ id }) => {
  // attempt to remove from UI
  const rows = Array.from(usersDiv.children);
  rows.forEach(r => { if (r.textContent.includes(id.slice(0,4))) r.remove(); });
});

// Vote flow
socket.on('server:clear_all_vote_started', ({ voteId, total, yesCount }) => {
  activeVoteId = voteId;
  voteClearBtn.textContent = `Vote in progress (${yesCount}/${total})`;
  if (!votedSet.has(voteId)) {
    const yes = confirm('Clear whole canvas? Requires unanimous YES.');
    votedSet.add(voteId);
    socket.emit('client:clear_all_vote', { voteId, yes });
  }
});
socket.on('server:clear_all_vote_progress', ({ voteId, total, yesCount }) => {
  if (activeVoteId !== voteId) return;
  voteClearBtn.textContent = `Vote in progress (${yesCount}/${total})`;
});
socket.on('server:clear_all_applied', ({ voteId }) => {
  if (activeVoteId !== voteId) return;
  for (const op of cs.getOpLog()) op.tombstone = true;
  cs.fullReplay();
  voteClearBtn.textContent = 'Request Clear (vote)';
  activeVoteId = null;
});

// cursors (throttled send)
let lastCursorSent = 0;
function sendCursor(p) {
  const now = performance.now();
  if (now - lastCursorSent > 33) {
    socket.emit('client:cursor', p);
    lastCursorSent = now;
  }
}
socket.on('server:cursor', ({ userId, x, y }) => {
  cs.setRemoteCursor(userId, x, y);
});

// Wire pointer handlers from canvas system
const handlers = cs.initPointerHandlers({
  emitFn: (kind, data) => {
    // normalize kind: if eraser mode, swap to erase:* before call (canvas passes stroke:* by default)
    if (data && data.brush && data.brush.mode === 'eraser') {
      // translate strokes to erase events
      if (kind === 'stroke:start') kind = 'erase:start';
      if (kind === 'stroke:point') kind = 'erase:point';
      if (kind === 'stroke:end') kind = 'erase:end';
    }
    socket.emit('client:op', { kind, data });
  },
  getMyId: () => socket.id,
  defaultBrush: brush
});

// local cursor sending: attach pointermove to visible canvas for presence
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const p = { x: e.clientX - r.left, y: e.clientY - r.top };
  sendCursor(p);
});

// helper: expose opLog for local use
cs.getOpLog = () => cs.getOpLog ? cs.getOpLog() : [];

// ready
console.log('canvas client wired');

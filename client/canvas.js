// client/canvas.js
// Exports createCanvasSystem(options)
// Usage: import { createCanvasSystem } from './canvas.js';

function cryptoRandomId() {
  // quick UUID for group ids (not crypto-critical)
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

/**
 * createCanvasSystem
 * @param {HTMLCanvasElement} canvas - visible canvas element
 * @param {HTMLElement} wrap - container element for cursor overlays & sizing
 * @returns {object} API: { initPointerHandlers, applyOp, fullReplay, setOpLog, getOpLog, emitOp }
 */
export function createCanvasSystem({ canvas, wrap }) {
  const ctx = canvas.getContext('2d');
  const offscreen = document.createElement('canvas');
  const octx = offscreen.getContext('2d');

  // Logical state used to render ops deterministically
  let opLog = []; // array of ops from server (with tombstone flag)
  const lastSeg = new Map();    // userId -> last point (for in-progress strokes)
  const currBrush = new Map();  // userId -> { color, width, mode }

  // Remote cursors
  const cursors = new Map(); // userId -> {x,y}
  const cursorElems = new Map();

  // Local drawing / group tracking (for emitting)
  let localGroupId = null;

  // Resize helper – call on load & window resize
  function resize() {
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(r.width));
    canvas.height = Math.max(1, Math.floor(r.height));
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    fullReplay();
  }

  // Draw a single small segment (p0 -> p1) on a given 2D context
  function drawSegment(g, p0, p1, width, color, mode) {
    if (!p0 || !p1) return;
    g.save();
    if (mode === 'eraser') {
      g.globalCompositeOperation = 'destination-out';
      g.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = color;
    }
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(p0.x, p0.y);
    g.lineTo(p1.x, p1.y);
    g.stroke();
    g.restore();
  }

  // Blit offscreen -> visible and draw cursors
  function blit() {
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(offscreen, 0, 0);
    drawRemoteCursors();
  }

  // Cursor UI management
  function drawRemoteCursors() {
    for (const [uid, pos] of cursors) {
      let el = cursorElems.get(uid);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rcursor';
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        el.style.transform = 'translate(-50%,-50%)';
        el.style.fontSize = '14px';
        el.textContent = '⬤';
        wrap.appendChild(el);
        cursorElems.set(uid, el);
      }
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    // remove stale
    for (const [uid, el] of cursorElems) {
      if (!cursors.has(uid)) { el.remove(); cursorElems.delete(uid); }
    }
  }

  // Apply a single op to offscreen context (incremental)
  function applyOpToContext(g, op) {
    const d = op.data || {};
    const uid = d.userId;
    const k = op.kind;
    if (!uid) return;

    if (k.endsWith(':start')) {
      lastSeg.set(uid, d.p);
      const mode = k.startsWith('erase') ? 'eraser' : 'brush';
      const b = d.brush || { color: '#222', width: 4, mode };
      currBrush.set(uid, { color: b.color, width: b.width, mode });
      return;
    }

    if (k.endsWith(':point')) {
      const p0 = lastSeg.get(uid);
      const p1 = d.p;
      const brush = currBrush.get(uid) || { color: '#222', width: 4, mode: k.startsWith('erase') ? 'eraser' : 'brush' };
      drawSegment(g, p0, p1, brush.width, brush.color, brush.mode);
      lastSeg.set(uid, p1);
      return;
    }

    if (k.endsWith(':end')) {
      lastSeg.delete(uid);
      currBrush.delete(uid);
      return;
    }

    // system ops (clear_all) are handled via tombstone logic in fullReplay
  }

  // Full deterministic replay from opLog -> offscreen
  function fullReplay() {
    octx.clearRect(0,0,offscreen.width,offscreen.height);
    lastSeg.clear();
    currBrush.clear();
    for (const op of opLog) {
      if (!op.tombstone) applyOpToContext(octx, op);
    }
    blit();
  }

  // Public: set the stored opLog (e.g., snapshot from server) and replay
  function setOpLog(newLog) {
    opLog = newLog.map(o => ({ ...o })); // shallow copy
    fullReplay();
  }

  function getOpLog() { return opLog; }

  // Public: apply a single op received from server incrementally (pushed to opLog)
  function applyOp(op) {
    opLog.push(op);
    // If op is structural or tombstoned, prefer fullReplay for correctness
    if (op.tombstone || op.kind === 'system:clear_all' || op.kind.endsWith(':end')) {
      fullReplay();
    } else {
      // quick incremental draw for performance
      applyOpToContext(octx, op);
      blit();
    }
  }

  // Expose cursors setter
  function setRemoteCursor(userId, x, y) {
    // keep coordinates within bounding rect
    cursors.set(userId, { x, y });
    drawRemoteCursors();
  }

  function removeRemoteCursor(userId) {
    cursors.delete(userId);
    drawRemoteCursors();
  }

  // Pointer helpers
  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    // support both mouse and touch pointer events
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
  }

  // Setup pointer handlers to emit ops via emitFn
  // emitFn(kind, data) must be provided by caller (usually will call socket.emit)
  function initPointerHandlers({ emitFn, getMyId, defaultBrush = { color: '#222', width: 4, mode: 'brush' } }) {
    // local brush state
    let brush = { ...defaultBrush };
    let drawing = false;
    let lastLocal = null;
    let currentGroup = null;

    // pointerdown
    function down(e) {
      // only left button for mouse
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drawing = true;
      currentGroup = cryptoRandomId();
      lastLocal = pointerPos(e);

      // emit start with brush metadata
      emitFn('stroke:start', { userId: getMyId(), groupId: currentGroup, brush: { ...brush }, p: lastLocal });
      // draw local preview immediately
      // we emulate server op application for local instant feedback:
      applyOp({ kind: 'stroke:start', data: { userId: getMyId(), groupId: currentGroup, brush: { ...brush }, p: lastLocal }, seq: -1, id: 'local', tombstone: false });
      canvas.setPointerCapture(e.pointerId);
    }

    // pointermove
    function move(e) {
      const p = pointerPos(e);
      // throttle cursor emission handled by main app if needed; here we emit drawing ops raw
      if (!drawing) return;
      // local draw to offscreen via an op
      const op = { kind: 'stroke:point', data: { userId: getMyId(), groupId: currentGroup, p }, seq: -1, id: 'localpoint', tombstone: false };
      applyOpToContext(octx, op); // draw incremental locally
      blit();
      // send to server
      emitFn('stroke:point', { userId: getMyId(), groupId: currentGroup, p });
      lastLocal = p;
    }

    // pointerup / cancel
    function up(e) {
      if (!drawing) return;
      drawing = false;
      emitFn('stroke:end', { userId: getMyId(), groupId: currentGroup });
      applyOp({ kind: 'stroke:end', data: { userId: getMyId(), groupId: currentGroup }, seq: -1, id: 'localend', tombstone: false });
      currentGroup = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    }

    // Eraser switch helper
    function setMode(mode, color, width) {
      brush.mode = mode;
      if (color) brush.color = color;
      if (width) brush.width = width;
    }

    // Attach listeners
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    return {
      setMode,
      detach() {
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      }
    };
  }

  // Exposed API
  return {
    resize,
    setOpLog,
    getOpLog,
    applyOp,
    fullReplay,
    initPointerHandlers,
    setRemoteCursor,
    removeRemoteCursor
  };
}


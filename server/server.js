import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(express.static('public'));


const ROOM = 'main';
let seq = 0;


const ops = [];            
const groups = new Map(); 
const undoStack = [];      
const redoStack = [];      

const users = new Map();  
const COLORS = ['#f44336','#3f51b5','#009688','#ff9800','#9c27b0','#03a9f4','#8bc34a','#795548','#e91e63','#00bcd4'];
const nextColor = i => COLORS[i % COLORS.length];


const vote = { inProgress:false, yes:new Set(), totalAtStart:0 };

function addOp(kind, data) {
  const op = { seq: ++seq, id: crypto.randomUUID(), kind, data, tombstone: false };
  ops.push(op);

  if (kind.endsWith(':start')) {
    const gid = data.groupId;
    groups.set(gid, { kind, by: data.userId, seqs: [op.seq], tombstone: false });
  } else if (kind.endsWith(':point')) {
    const g = groups.get(data.groupId);
    if (g) g.seqs.push(op.seq);
  } else if (kind.endsWith(':end')) {
    const g = groups.get(data.groupId);
    if (g) {
      g.seqs.push(op.seq);
      undoStack.push(data.groupId);
      redoStack.length = 0; 
    }
  } else if (kind === 'system:clear_all') {
    undoStack.length = 0;
    redoStack.length = 0;
  }

  return op;
}

function setGroupTombstone(groupId, val) {
  const g = groups.get(groupId);
  if (!g) return false;
  g.tombstone = val;
  for (const s of g.seqs) {
    const o = ops.find(x => x.seq === s);
    if (o) o.tombstone = val;
  }
  return true;
}

function performUndo() {
  
  while (undoStack.length) {
    const gid = undoStack[undoStack.length - 1];
    const g = groups.get(gid);
    if (g && !g.tombstone) {
      setGroupTombstone(gid, true);
      redoStack.push(gid);
      undoStack.pop();
      return gid;
    }
   
    undoStack.pop();
  }
  return null;
}

function performRedo() {
  while (redoStack.length) {
    const gid = redoStack.pop();
    const g = groups.get(gid);
    if (g && g.tombstone) {
      setGroupTombstone(gid, false);
      undoStack.push(gid);
      return gid;
    }
  }
  return null;
}

io.on('connection', (socket) => {
 
  const user = { id: socket.id, color: nextColor(users.size) };
  users.set(socket.id, user);
  socket.join(ROOM);

  
  socket.emit('server:snapshot', {
    seq,
    ops,
    users: Array.from(users.values()),
  });

  io.to(ROOM).emit('server:user_joined', user);

 
  socket.on('client:cursor', (pos) => {
    socket.to(ROOM).emit('server:cursor', { userId: socket.id, ...pos });
  });

  
  socket.on('client:op', (msg) => {
    if ((msg.kind.startsWith('stroke:') || msg.kind.startsWith('erase:')) && !msg.data.groupId) {
      msg.data.groupId = crypto.randomUUID();
    }
    const op = addOp(msg.kind, msg.data);
    io.to(ROOM).emit('server:op', op);
  });


  socket.on('client:undo', () => {
    const gid = performUndo();
    if (gid) io.to(ROOM).emit('server:undo_group', { groupId: gid });
  });
  socket.on('client:redo', () => {
    const gid = performRedo();
    if (gid) io.to(ROOM).emit('server:redo_group', { groupId: gid });
  });

  
  socket.on('client:clear_all_request', () => {
    if (vote.inProgress) return;
    vote.inProgress = true;
    vote.yes = new Set([socket.id]);
    vote.totalAtStart = users.size;
    io.to(ROOM).emit('server:clear_all_vote_started', { total: vote.totalAtStart, yesCount: vote.yes.size });
    if (vote.yes.size >= vote.totalAtStart) finalizeClear();
  });

  socket.on('client:clear_all_vote', ({ yes }) => {
    if (!vote.inProgress) return;
    if (yes) vote.yes.add(socket.id);
    io.to(ROOM).emit('server:clear_all_vote_progress', { total: vote.totalAtStart, yesCount: vote.yes.size });
    if (vote.yes.size >= vote.totalAtStart) finalizeClear();
  });

  function finalizeClear() {
    const sys = addOp('system:clear_all', { by: 'vote' });
   
    for (const g of groups.values()) g.tombstone = true;
    for (const o of ops) if (o.id !== sys.id) o.tombstone = true;
    io.to(ROOM).emit('server:clear_all_applied', { seq: sys.seq });
    vote.inProgress = false;
  }

  socket.on('disconnect', () => {
    users.delete(socket.id);
    io.to(ROOM).emit('server:user_left', { id: socket.id });

   
    if (vote.inProgress) {
      vote.totalAtStart = Math.max(vote.totalAtStart - 1, 0);
      io.to(ROOM).emit('server:clear_all_vote_progress', { total: vote.totalAtStart, yesCount: vote.yes.size });
      if (vote.yes.size >= vote.totalAtStart) finalizeClear();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(` Server on http://localhost:${PORT}`));

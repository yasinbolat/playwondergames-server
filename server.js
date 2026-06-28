const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const SPAWN_POINTS = {
  forest: [
    { x: 200, y: 200 }, { x: 2200, y: 200 }, { x: 200, y: 1600 }, { x: 2200, y: 1600 },
    { x: 1200, y: 900 }, { x: 600, y: 900 }, { x: 1800, y: 900 }, { x: 1200, y: 400 },
  ],
  maze: [
    { x: 168, y: 171 }, { x: 2224, y: 171 }, { x: 168, y: 1623 }, { x: 2224, y: 1623 },
    { x: 1196, y: 171 }, { x: 1196, y: 1623 }, { x: 168, y: 897 }, { x: 2224, y: 897 },
  ],
  city: [
    { x: 200, y: 200 }, { x: 2200, y: 200 }, { x: 200, y: 1600 }, { x: 2200, y: 1600 },
    { x: 1200, y: 900 }, { x: 700, y: 900 }, { x: 1700, y: 900 }, { x: 1200, y: 400 },
  ],
  space: [
    { x: 200, y: 200 }, { x: 2200, y: 200 }, { x: 200, y: 1600 }, { x: 2200, y: 1600 },
    { x: 1200, y: 900 }, { x: 500, y: 500 }, { x: 1900, y: 500 }, { x: 1200, y: 1400 },
  ],
};

function createRoom(mapId = 'forest') {
  let code;
  do { code = genCode(); } while (rooms[code]);
  rooms[code] = {
    code, mapId,
    players: {},
    master: null, ebe: null,
    timer: 60, timerInterval: null, countdownInterval: null,
    status: 'lobby', // lobby | countdown | playing | roundEnd
    round: 0,
    isQuickMatch: false,
  };
  return rooms[code];
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomState', {
    players: room.players, master: room.master, ebe: room.ebe,
    timer: room.timer, status: room.status, mapId: room.mapId,
    code: room.code, round: room.round, isQuickMatch: room.isQuickMatch,
  });
}

function transferMaster(room) {
  const ids = Object.keys(room.players);
  if (!ids.length) return;
  for (const id in room.players) room.players[id].isMaster = false;
  const newMaster = ids[Math.floor(Math.random() * ids.length)];
  room.master = newMaster;
  room.players[newMaster].isMaster = true;
  io.to(room.code).emit('masterChanged', { master: newMaster });
}

function startCountdown(room, duration) {
  if (room.status !== 'lobby') return;
  const count0 = Object.keys(room.players).length;
  if (count0 < 2) return;
  if (count0 >= 8) { startRound(room); return; }

  const secs = duration || (room.isQuickMatch ? 15 : 5);
  room.status = 'countdown';
  let count = secs;
  io.to(room.code).emit('countdown', { count });

  room.countdownInterval = setInterval(() => {
    if (Object.keys(room.players).length < 2) {
      clearInterval(room.countdownInterval);
      room.status = 'lobby';
      broadcastRoom(room);
      return;
    }
    count--;
    if (count <= 0) {
      clearInterval(room.countdownInterval);
      startRound(room);
    } else {
      io.to(room.code).emit('countdown', { count });
    }
  }, 1000);
}

function startRound(room) {
  clearInterval(room.countdownInterval);
  room.status = 'playing';
  room.round++;

  const ids = Object.keys(room.players);
  const candidates = (room.ebe && ids.length > 1) ? ids.filter(id => id !== room.ebe) : ids;
  const ebeId = candidates[Math.floor(Math.random() * candidates.length)];
  room.ebe = ebeId;

  const spawns = SPAWN_POINTS[room.mapId] || SPAWN_POINTS.forest;
  ids.forEach((id, i) => {
    const s = spawns[i % spawns.length];
    room.players[id].x = s.x;
    room.players[id].y = s.y;
    room.players[id].isEbe = id === ebeId;
  });

  room.timer = 60;

  io.to(room.code).emit('roundStart', {
    players: room.players, ebe: ebeId,
    timer: room.timer, round: room.round, mapId: room.mapId,
  });

  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(room.code).emit('timerUpdate', { timer: room.timer });
    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      endRound(room, room.ebe, 'timeout');
    }
  }, 1000);
}

function endRound(room, loserId, reason) {
  clearInterval(room.timerInterval);
  room.status = 'roundEnd';
  const loser = room.players[loserId];

  for (const id in room.players) {
    if (id !== loserId) {
      room.players[id].score = (room.players[id].score || 0) + 1;
      room.players[id].xpGained = (room.players[id].xpGained || 0) + 10;
    }
  }

  io.to(room.code).emit('roundEnd', {
    loser: loserId,
    loserNickname: loser?.nickname || '?',
    players: room.players,
    reason,
  });
}

function switchEbe(room, newEbeId) {
  clearInterval(room.timerInterval);
  room.players[room.ebe].isEbe = false;
  room.ebe = newEbeId;
  room.players[newEbeId].isEbe = true;
  room.players[newEbeId].tagImmunityUntil = Date.now() + 1500;
  room.timer = 60;

  io.to(room.code).emit('ebeChanged', {
    newEbe: newEbeId,
    newEbeNickname: room.players[newEbeId]?.nickname || '?',
    players: room.players,
    timer: room.timer,
  });

  room.timerInterval = setInterval(() => {
    room.timer--;
    io.to(room.code).emit('timerUpdate', { timer: room.timer });
    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      endRound(room, room.ebe, 'timeout');
    }
  }, 1000);
}

function playerJoin(socket, room, uid, nickname, baseWins) {
  const hue = Math.floor(Math.random() * 360);
  const spawns = SPAWN_POINTS[room.mapId] || SPAWN_POINTS.forest;
  const idx = Object.keys(room.players).length;
  const s = spawns[idx % spawns.length];

  room.players[socket.id] = {
    id: socket.id, uid, nickname,
    color: `hsl(${hue},70%,55%)`,
    x: s.x, y: s.y,
    isEbe: false, isMaster: false,
    score: 0, xpGained: 0,
    baseWins: Number(baseWins) || 0, // permanent career wins at join (for display)
  };

  if (!room.master) {
    room.master = socket.id;
    room.players[socket.id].isMaster = true;
  }

  socket.join(room.code);
  socket.roomCode = room.code;
  socket.uid = uid;

  io.to(room.code).emit('playerJoined', {
    players: room.players, master: room.master,
    code: room.code, mapId: room.mapId, status: room.status,
    isQuickMatch: room.isQuickMatch,
  });

  if (room.isQuickMatch && Object.keys(room.players).length >= 2 && room.status === 'lobby') {
    startCountdown(room);
  }
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('createRoom', ({ uid, nickname, mapId, baseWins }) => {
    const room = createRoom(mapId || 'forest');
    playerJoin(socket, room, uid, nickname, baseWins);
    socket.emit('roomCreated', { code: room.code });
  });

  socket.on('joinRoom', ({ uid, nickname, code, baseWins }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('joinError', { msg: 'Oda bulunamadı' }); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('joinError', { msg: 'Oda dolu (max 8)' }); return; }
    if (room.status === 'playing' || (room.status === 'countdown' && !room.isQuickMatch)) { socket.emit('joinError', { msg: 'Oyun devam ediyor' }); return; }
    playerJoin(socket, room, uid, nickname, baseWins);
  });

  socket.on('joinQuickMatch', ({ uid, nickname, mapId, baseWins }) => {
    const key = mapId || 'forest';
    let found = null;
    for (const code in rooms) {
      const r = rooms[code];
      if (r.mapId === key && r.isQuickMatch && (r.status === 'lobby' || r.status === 'countdown') && Object.keys(r.players).length < 8) {
        found = r; break;
      }
    }
    if (!found) { found = createRoom(key); found.isQuickMatch = true; }
    playerJoin(socket, found, uid, nickname, baseWins);
  });

  socket.on('move', ({ x, y }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    player.x = Math.max(10, Math.min(2390, x));
    player.y = Math.max(10, Math.min(1790, y));
    socket.to(socket.roomCode).emit('playerMoved', { id: socket.id, x: player.x, y: player.y });
  });

  // Client-authoritative tag: the IT player's client claims a tag (it sees the
  // freshest overlap). Server validates loosely against latency/interpolation.
  socket.on('claimTag', ({ target }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'playing' || room.ebe !== socket.id) return;
    const ebe = room.players[socket.id], tp = room.players[target];
    if (!ebe || !tp) return;
    const now = Date.now();
    if (tp.tagImmunityUntil && now < tp.tagImmunityUntil) return;
    if (ebe.tagImmunityUntil && now < ebe.tagImmunityUntil) return;
    // sanity check: reject only if clearly impossible (anti-teleport), generous for lag
    const dx = ebe.x - tp.x, dy = ebe.y - tp.y;
    if (dx * dx + dy * dy > 120 * 120) return;
    switchEbe(room, target);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || room.master !== socket.id) return;
    if (room.status === 'roundEnd') room.status = 'lobby';
    if (room.status === 'lobby') startCountdown(room);
  });

  socket.on('changeMap', ({ mapId }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.master !== socket.id || room.status !== 'lobby') return;
    if (!SPAWN_POINTS[mapId]) return;
    room.mapId = mapId;
    io.to(room.code).emit('mapChanged', { mapId });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const leftNickname = room.players[socket.id]?.nickname || '?';
    const wasEbe = room.status === 'playing' && room.ebe === socket.id;
    delete room.players[socket.id];
    const remaining = Object.keys(room.players).length;

    if (remaining === 0) {
      clearInterval(room.timerInterval);
      clearInterval(room.countdownInterval);
      delete rooms[room.code];
      return;
    }

    if (room.master === socket.id) transferMaster(room);

    if (room.status === 'countdown' && remaining < 2) {
      clearInterval(room.countdownInterval);
      room.status = 'lobby';
    }

    io.to(room.code).emit('playerLeft', {
      id: socket.id, nickname: leftNickname, players: room.players, master: room.master,
    });

    if (wasEbe) {
      clearInterval(room.timerInterval);
      if (remaining < 2) {
        room.status = 'lobby';
        room.ebe = null;
        broadcastRoom(room);
      } else {
        room.status = 'lobby';
        room.ebe = null;
        io.to(room.code).emit('ebeLeft', { nickname: leftNickname });
        setTimeout(() => {
          if (Object.keys(room.players).length >= 2 && room.status === 'lobby') {
            startRound(room);
          }
        }, 3000);
      }
    } else if (room.status === 'playing' && remaining < 2) {
      clearInterval(room.timerInterval);
      room.status = 'lobby';
      room.ebe = null;
      broadcastRoom(room);
    }
  });
});

app.get('/', (req, res) => res.send('PlayWonderGames Server çalışıyor.'));
httpServer.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));

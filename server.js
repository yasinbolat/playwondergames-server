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
    { x: 150, y: 150 }, { x: 2250, y: 150 }, { x: 150, y: 1650 }, { x: 2250, y: 1650 },
    { x: 1200, y: 880 }, { x: 600, y: 350 }, { x: 1800, y: 350 }, { x: 600, y: 1450 },
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
    code: room.code, round: room.round,
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

function startCountdown(room) {
  if (room.status !== 'lobby') return;
  const count0 = Object.keys(room.players).length;
  if (count0 < 2) return;
  if (count0 >= 8) { startRound(room); return; }

  room.status = 'countdown';
  let count = 5;
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

function checkTag(room, moverId) {
  if (room.status !== 'playing' || room.ebe !== moverId) return;
  const ebe = room.players[moverId];
  if (!ebe) return;
  const now = Date.now();
  if (ebe.tagImmunityUntil && now < ebe.tagImmunityUntil) return;
  for (const id in room.players) {
    if (id === moverId) continue;
    const p = room.players[id];
    if (p.tagImmunityUntil && now < p.tagImmunityUntil) continue;
    const dx = ebe.x - p.x, dy = ebe.y - p.y;
    if (Math.sqrt(dx * dx + dy * dy) < 44) {
      switchEbe(room, id);
      break;
    }
  }
}

function playerJoin(socket, room, uid, nickname) {
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
  });

  if (Object.keys(room.players).length >= 2 && room.status === 'lobby') {
    startCountdown(room);
  }
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('createRoom', ({ uid, nickname, mapId }) => {
    const room = createRoom(mapId || 'forest');
    playerJoin(socket, room, uid, nickname);
    socket.emit('roomCreated', { code: room.code });
  });

  socket.on('joinRoom', ({ uid, nickname, code }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('joinError', { msg: 'Oda bulunamadı' }); return; }
    if (Object.keys(room.players).length >= 8) { socket.emit('joinError', { msg: 'Oda dolu (max 8)' }); return; }
    if (room.status === 'playing') { socket.emit('joinError', { msg: 'Oyun devam ediyor' }); return; }
    playerJoin(socket, room, uid, nickname);
  });

  socket.on('joinQuickMatch', ({ uid, nickname, mapId }) => {
    const key = mapId || 'forest';
    let found = null;
    for (const code in rooms) {
      const r = rooms[code];
      if (r.mapId === key && r.isQuickMatch && r.status === 'lobby' && Object.keys(r.players).length < 8) {
        found = r; break;
      }
    }
    if (!found) { found = createRoom(key); found.isQuickMatch = true; }
    playerJoin(socket, found, uid, nickname);
  });

  socket.on('move', ({ x, y }) => {
    const room = rooms[socket.roomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    player.x = Math.max(10, Math.min(2390, x));
    player.y = Math.max(10, Math.min(1790, y));
    socket.to(socket.roomCode).emit('playerMoved', { id: socket.id, x: player.x, y: player.y });
    checkTag(room, socket.id);
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
    delete room.players[socket.id];
    const remaining = Object.keys(room.players).length;

    if (remaining === 0) {
      clearInterval(room.timerInterval);
      clearInterval(room.countdownInterval);
      delete rooms[room.code];
      return;
    }

    if (room.master === socket.id) transferMaster(room);

    if (room.status === 'playing' && room.ebe === socket.id) {
      const ids = Object.keys(room.players);
      const newEbeId = ids[Math.floor(Math.random() * ids.length)];
      switchEbe(room, newEbeId);
    }

    if (room.status === 'countdown' && remaining < 2) {
      clearInterval(room.countdownInterval);
      room.status = 'lobby';
    }

    io.to(room.code).emit('playerLeft', {
      id: socket.id, players: room.players, master: room.master,
    });
  });
});

app.get('/', (req, res) => res.send('PlayWonderGames Server çalışıyor.'));
httpServer.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor.`));

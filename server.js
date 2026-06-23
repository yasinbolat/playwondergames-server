const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Aktif odalar
const rooms = {};

function createRoom(roomId) {
    return {
        id: roomId,
        players: {},
        ebe: null,
        timer: 60,
        timerInterval: null,
        status: 'waiting' // waiting | playing | finished
    };
}

function getOrCreateQuickMatch() {
    // Dolmamış bekleyen oda bul
    for (const roomId in rooms) {
        const room = rooms[roomId];
        if (room.status === 'waiting' && Object.keys(room.players).length < 5) {
            return roomId;
        }
    }
    // Yoksa yeni oda oluştur
    const roomId = 'room_' + Date.now();
    rooms[roomId] = createRoom(roomId);
    return roomId;
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = 'playing';

    // Rastgele ebe seç
    const playerIds = Object.keys(room.players);
    const ebeId = playerIds[Math.floor(Math.random() * playerIds.length)];
    room.ebe = ebeId;

    // Herkese başlangıç pozisyonu ver
    playerIds.forEach((id, index) => {
        const angle = (index / playerIds.length) * Math.PI * 2;
        room.players[id].x = 400 + Math.cos(angle) * 200;
        room.players[id].y = 300 + Math.sin(angle) * 150;
        room.players[id].isEbe = id === ebeId;
    });

    room.timer = 60;

    // Herkese oyun başladı bildir
    io.to(roomId).emit('gameStart', {
        players: room.players,
        ebe: ebeId,
        timer: room.timer
    });

    // Timer başlat
    room.timerInterval = setInterval(() => {
        room.timer--;
        io.to(roomId).emit('timerUpdate', { timer: room.timer });

        if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            // Ebe süre doldu, kaybetti
            io.to(roomId).emit('gameOver', {
                loser: room.ebe,
                reason: 'timeout'
            });
            room.status = 'finished';
            setTimeout(() => { delete rooms[roomId]; }, 5000);
        }
    }, 1000);
}

function checkTag(room, moverId) {
    if (!room || room.status !== 'playing') return;
    if (room.ebe !== moverId) return; // Sadece ebe ebeleyebilir

    const ebe = room.players[moverId];
    if (!ebe) return;

    for (const id in room.players) {
        if (id === moverId) continue;
        const player = room.players[id];
        const dx = ebe.x - player.x;
        const dy = ebe.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 36) { // 36px çarpışma mesafesi
            // Ebe değişti!
            clearInterval(room.timerInterval);

            room.players[room.ebe].isEbe = false;
            room.ebe = id;
            room.players[id].isEbe = true;
            room.timer = 60;

            io.to(room.id).emit('ebeChanged', {
                newEbe: id,
                players: room.players,
                timer: room.timer
            });

            // Yeni timer başlat
            room.timerInterval = setInterval(() => {
                room.timer--;
                io.to(room.id).emit('timerUpdate', { timer: room.timer });
                if (room.timer <= 0) {
                    clearInterval(room.timerInterval);
                    io.to(room.id).emit('gameOver', {
                        loser: room.ebe,
                        reason: 'timeout'
                    });
                    room.status = 'finished';
                    setTimeout(() => { delete rooms[room.id]; }, 5000);
                }
            }, 1000);
            break;
        }
    }
}

io.on('connection', (socket) => {
    console.log('Bağlandı:', socket.id);

    // Quick Match
    socket.on('joinQuickMatch', ({ uid, nickname }) => {
        const roomId = getOrCreateQuickMatch();
        const room = rooms[roomId];

        socket.join(roomId);
        socket.roomId = roomId;
        socket.uid = uid;

        room.players[socket.id] = {
            id: socket.id,
            uid,
            nickname,
            x: 400,
            y: 300,
            isEbe: false
        };

        // Odadakilere yeni oyuncu bildir
        io.to(roomId).emit('playerJoined', {
            players: room.players,
            count: Object.keys(room.players).length
        });

        // 5 kişi doldu mu?
        if (Object.keys(room.players).length >= 5) {
            startGame(roomId);
        }
    });

    // Pozisyon güncelleme
    socket.on('move', ({ x, y }) => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'playing') return;
        if (!room.players[socket.id]) return;

        room.players[socket.id].x = x;
        room.players[socket.id].y = y;

        // Diğerlerine yayınla (kendisi hariç)
        socket.to(socket.roomId).emit('playerMoved', {
            id: socket.id,
            x, y
        });

        // Çarpışma kontrol
        checkTag(room, socket.id);
    });

    // Ayrılma
    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (!room) return;

        delete room.players[socket.id];
        io.to(socket.roomId).emit('playerLeft', {
            id: socket.id,
            players: room.players
        });

        // Odada kimse kalmadıysa sil
        if (Object.keys(room.players).length === 0) {
            clearInterval(room.timerInterval);
            delete rooms[socket.roomId];
        }
    });
});

app.get('/', (req, res) => res.send('PlayWonderGames Server çalışıyor.'));

httpServer.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
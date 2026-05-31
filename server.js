const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const AREA = { w: 960, h: 540 };
const TANK_RADIUS = 18;
const TANK_SPEED = 150;
const ROTATE_SPEED = Math.PI * 0.72;
const BULLET_SPEED = 360;
const BULLET_RADIUS = 6;
const CHARGE_TIME = 2;
const WIN_SCORE = 5;
const BROADCAST_HZ = 30;
const OBSTACLES = [
  { id: 'center', x: 430, y: 230, w: 100, h: 80 },
  { id: 'leftBlock', x: 270, y: 120, w: 90, h: 44 },
  { id: 'rightBlock', x: 600, y: 376, w: 90, h: 44 },
];

const rooms = new Map();

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeTank(slot, name, socketId, token) {
  const left = slot === 0;
  return {
    slot,
    name: name || `P${slot + 1}`,
    socketId,
    token,
    connected: true,
    x: left ? 160 : AREA.w - 160,
    y: AREA.h / 2,
    angle: left ? 0 : Math.PI,
    hold: false,
    charge: 0,
    score: 0,
    color: left ? '#38bdf8' : '#fb7185',
  };
}

function resetPositions(room) {
  room.tanks.forEach((tank) => {
    if (!tank) return;
    const left = tank.slot === 0;
    tank.x = left ? 160 : AREA.w - 160;
    tank.y = AREA.h / 2;
    tank.angle = left ? 0 : Math.PI;
    tank.hold = false;
    tank.charge = 0;
  });
  room.bullets = [];
  room.roundResetUntil = Date.now() + 700;
}

function publicState(room) {
  return {
    code: room.code,
    area: AREA,
    status: room.status,
    winnerSlot: room.winnerSlot,
    winScore: WIN_SCORE,
    chargeTime: CHARGE_TIME,
    obstacles: OBSTACLES,
    tanks: room.tanks.map((t) => t && ({
      slot: t.slot,
      name: t.name,
      connected: t.connected,
      x: t.x,
      y: t.y,
      angle: t.angle,
      hold: t.hold,
      charge: t.charge,
      score: t.score,
      color: t.color,
    })),
    bullets: room.bullets,
    roundResetUntil: room.roundResetUntil,
    message: room.message,
  };
}

function createRoom(hostName, socket) {
  const code = roomCode();
  const token = cryptoToken();
  const room = {
    code,
    status: 'waiting',
    tanks: [makeTank(0, hostName, socket.id, token), null],
    bullets: [],
    winnerSlot: null,
    message: '相手の参加を待っています。',
    lastTick: Date.now(),
    roundResetUntil: 0,
  };
  rooms.set(code, room);
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.slot = 0;
  socket.data.token = token;
  socket.emit('joined', { code, slot: 0, token });
  emitRoom(room);
}

function joinRoom(code, name, socket, token) {
  code = String(code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    socket.emit('errorMessage', '部屋が見つかりません。');
    return;
  }

  let slot = -1;
  if (token) {
    slot = room.tanks.findIndex((tank) => tank && tank.token === token);
  }
  if (slot === -1) {
    slot = room.tanks.findIndex((tank) => !tank);
  }
  if (slot === -1) {
    socket.emit('errorMessage', 'この部屋は満員です。');
    return;
  }

  if (room.tanks[slot]) {
    room.tanks[slot].socketId = socket.id;
    room.tanks[slot].connected = true;
    if (name) room.tanks[slot].name = name;
  } else {
    token = cryptoToken();
    room.tanks[slot] = makeTank(slot, name, socket.id, token);
  }

  socket.join(code);
  socket.data.roomCode = code;
  socket.data.slot = slot;
  socket.data.token = room.tanks[slot].token;
  socket.emit('joined', { code, slot, token: room.tanks[slot].token });

  if (room.tanks[0] && room.tanks[1] && room.status === 'waiting') {
    startMatch(room);
  }
  emitRoom(room);
}

function startMatch(room) {
  room.status = 'playing';
  room.winnerSlot = null;
  room.tanks.forEach((tank) => {
    if (tank) tank.score = 0;
  });
  resetPositions(room);
  room.message = 'ゲーム開始！長押しで前進、2秒チャージで弾を発射します。';
}

function cryptoToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emitRoom(room) {
  io.to(room.code).emit('state', publicState(room));
}

function circleRectHit(cx, cy, radius, rect) {
  const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(cx - nearestX, cy - nearestY) <= radius;
}

function tankCanMove(room, tank, nextX, nextY) {
  if (nextX < TANK_RADIUS || nextX > AREA.w - TANK_RADIUS) return false;
  if (nextY < TANK_RADIUS || nextY > AREA.h - TANK_RADIUS) return false;

  for (const obstacle of OBSTACLES) {
    if (circleRectHit(nextX, nextY, TANK_RADIUS, obstacle)) return false;
  }

  for (const other of room.tanks) {
    if (!other || other.slot === tank.slot) continue;
    if (Math.hypot(nextX - other.x, nextY - other.y) < TANK_RADIUS * 2) return false;
  }

  return true;
}

function reflectBulletOnObstacle(bullet, prevX, prevY, obstacle) {
  if (!circleRectHit(bullet.x, bullet.y, BULLET_RADIUS, obstacle)) return false;

  const wasLeft = prevX <= obstacle.x - BULLET_RADIUS;
  const wasRight = prevX >= obstacle.x + obstacle.w + BULLET_RADIUS;
  const wasAbove = prevY <= obstacle.y - BULLET_RADIUS;
  const wasBelow = prevY >= obstacle.y + obstacle.h + BULLET_RADIUS;

  if ((wasLeft || wasRight) && !(wasAbove || wasBelow)) {
    bullet.vx *= -1;
    bullet.x = wasLeft ? obstacle.x - BULLET_RADIUS : obstacle.x + obstacle.w + BULLET_RADIUS;
  } else if ((wasAbove || wasBelow) && !(wasLeft || wasRight)) {
    bullet.vy *= -1;
    bullet.y = wasAbove ? obstacle.y - BULLET_RADIUS : obstacle.y + obstacle.h + BULLET_RADIUS;
  } else {
    const dxLeft = Math.abs(prevX - obstacle.x);
    const dxRight = Math.abs(prevX - (obstacle.x + obstacle.w));
    const dyTop = Math.abs(prevY - obstacle.y);
    const dyBottom = Math.abs(prevY - (obstacle.y + obstacle.h));
    const minSide = Math.min(dxLeft, dxRight, dyTop, dyBottom);
    if (minSide === dxLeft || minSide === dxRight) bullet.vx *= -1;
    else bullet.vy *= -1;
  }

  bullet.bounces += 1;
  return true;
}

function fireBullet(room, tank) {
  const muzzle = TANK_RADIUS + 10;
  room.bullets.push({
    id: cryptoToken(),
    owner: tank.slot,
    x: tank.x + Math.cos(tank.angle) * muzzle,
    y: tank.y + Math.sin(tank.angle) * muzzle,
    vx: Math.cos(tank.angle) * BULLET_SPEED,
    vy: Math.sin(tank.angle) * BULLET_SPEED,
    bounces: 0,
    maxBounces: 5,
  });
}

function scorePoint(room, scorerSlot) {
  const scorer = room.tanks[scorerSlot];
  if (!scorer || room.status !== 'playing') return;
  scorer.score += 1;
  if (scorer.score >= WIN_SCORE) {
    room.status = 'finished';
    room.winnerSlot = scorerSlot;
    room.message = `${scorer.name} の勝利！`;
    room.bullets = [];
    room.tanks.forEach((tank) => {
      if (tank) {
        tank.hold = false;
        tank.charge = 0;
      }
    });
  } else {
    room.message = `${scorer.name} が1ポイント！初期配置に戻ります。`;
    resetPositions(room);
  }
}

function updateRoom(room, dt) {
  if (room.status !== 'playing') return;
  if (!room.tanks[0] || !room.tanks[1]) return;
  if (Date.now() < room.roundResetUntil) return;

  for (const tank of room.tanks) {
    if (!tank) continue;
    if (tank.hold) {
      const nextX = tank.x + Math.cos(tank.angle) * TANK_SPEED * dt;
      const nextY = tank.y + Math.sin(tank.angle) * TANK_SPEED * dt;
      if (tankCanMove(room, tank, nextX, nextY)) {
        tank.x = nextX;
        tank.y = nextY;
      }
      tank.charge += dt;
      if (tank.charge >= CHARGE_TIME) {
        fireBullet(room, tank);
        tank.charge = 0;
        room.message = `${tank.name} が発射！`;
      }
    } else {
      tank.angle += ROTATE_SPEED * dt;
      if (tank.angle > Math.PI * 2) tank.angle -= Math.PI * 2;
      tank.charge = 0;
    }
  }

  const kept = [];
  for (const bullet of room.bullets) {
    const prevX = bullet.x;
    const prevY = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    let bounced = false;

    if (bullet.x < BULLET_RADIUS) {
      bullet.x = BULLET_RADIUS;
      bullet.vx *= -1;
      bounced = true;
    } else if (bullet.x > AREA.w - BULLET_RADIUS) {
      bullet.x = AREA.w - BULLET_RADIUS;
      bullet.vx *= -1;
      bounced = true;
    }
    if (bullet.y < BULLET_RADIUS) {
      bullet.y = BULLET_RADIUS;
      bullet.vy *= -1;
      bounced = true;
    } else if (bullet.y > AREA.h - BULLET_RADIUS) {
      bullet.y = AREA.h - BULLET_RADIUS;
      bullet.vy *= -1;
      bounced = true;
    }
    if (bounced) bullet.bounces += 1;
    if (!bounced) {
      for (const obstacle of OBSTACLES) {
        if (reflectBulletOnObstacle(bullet, prevX, prevY, obstacle)) {
          bounced = true;
          break;
        }
      }
    }
    if (bullet.bounces >= bullet.maxBounces) continue;

    let hit = false;
    for (const tank of room.tanks) {
      if (!tank) continue;
      const dx = tank.x - bullet.x;
      const dy = tank.y - bullet.y;
      if (Math.hypot(dx, dy) <= TANK_RADIUS + BULLET_RADIUS) {
        const scorerSlot = tank.slot === bullet.owner ? 1 - bullet.owner : bullet.owner;
        scorePoint(room, scorerSlot);
        hit = true;
        break;
      }
    }
    if (!hit && room.status === 'playing') kept.push(bullet);
  }
  room.bullets = kept;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => createRoom(name, socket));
  socket.on('joinRoom', ({ code, name, token }) => joinRoom(code, name, socket, token));

  socket.on('setHold', ({ hold }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const tank = room.tanks[socket.data.slot];
    if (!tank || tank.token !== socket.data.token) return;
    tank.hold = !!hold;
    if (!tank.hold) tank.charge = 0;
  });

  socket.on('restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.slot !== 0) return;
    if (!room.tanks[0] || !room.tanks[1]) {
      room.status = 'waiting';
      room.message = '相手の参加を待っています。';
    } else {
      startMatch(room);
    }
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const tank = room.tanks[socket.data.slot];
    if (tank && tank.socketId === socket.id) {
      tank.connected = false;
      tank.hold = false;
      tank.charge = 0;
      room.message = `${tank.name} が切断しました。再接続を待っています。`;
      emitRoom(room);
    }
    setTimeout(() => {
      const r = rooms.get(socket.data.roomCode);
      if (!r) return;
      const active = r.tanks.some((t) => t && t.connected);
      if (!active) rooms.delete(r.code);
    }, 1000 * 60 * 20);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const dt = Math.min(0.05, (now - room.lastTick) / 1000);
    room.lastTick = now;
    updateRoom(room, dt);
  }
}, 1000 / 60);

setInterval(() => {
  for (const room of rooms.values()) emitRoom(room);
}, 1000 / BROADCAST_HZ);

server.listen(PORT, () => console.log(`Tank Pixel server running on ${PORT}`));

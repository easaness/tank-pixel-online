const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size, loadedFromDisk }));

const PORT = process.env.PORT || 3000;
const SAVE_DIR = process.env.TANK_PIXEL_SAVE_DIR || path.join(__dirname, 'data');
const SAVE_FILE = path.join(SAVE_DIR, 'rooms.json');
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 全員が退出しても6時間は部屋を保持

const AREA = { w: 960, h: 540 };
const TANK_RADIUS = 18;
const TANK_SPEED = 150;
const SPEED_BOOST_MULTIPLIER = 1.45;
const SPEED_BOOST_MS = 8000;
const ROTATE_BOOST_MULTIPLIER = 1.65;
const ROTATE_BOOST_MS = 8000;
const CHARGE_BOOST_TIME = 1.15;
const CHARGE_BOOST_MS = 8000;
const SIZE_UP_MULTIPLIER = 1.45;
const SIZE_UP_MS = 8000;
const INVISIBLE_MS = 8000;
const ITEM_RADIUS = 13;
const ITEM_PICKUP_RADIUS = 30;
const ITEM_MAX_COUNT = 3;
const ITEM_RESPAWN_MS = 4500;
const ROTATE_SPEED = Math.PI * 0.72;
const BULLET_SPEED = 360;
const BULLET_RADIUS = 6;
const CHARGE_TIME = 2;
const WIN_SCORE = 5;
const BROADCAST_HZ = 30;
const OBSTACLE_HALF_WIDTH = 7;
const OBSTACLE_COUNT = 3;
const SPAWN_SAFE_RADIUS = 135;
const BUMP_BACK_DISTANCE = 10;
const BUMP_COOLDOWN = 0.12;
const SPAWNS = [
  { x: 150, y: AREA.h / 2, angle: 0 },
  { x: AREA.w - 150, y: AREA.h / 2, angle: Math.PI },
  { x: AREA.w / 2, y: 115, angle: Math.PI / 2 },
  { x: AREA.w / 2, y: AREA.h - 115, angle: -Math.PI / 2 },
];

const PLAYER_COLORS = ['#38bdf8', '#fb7185', '#4ade80', '#a78bfa'];

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pointLineDistance(px, py, line) {
  return distancePointToSegment(px, py, line.x1, line.y1, line.x2, line.y2).distance;
}

function lineLength(line) {
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
}

function isObstacleSafe(line, existing) {
  if (lineLength(line) < 90) return false;

  // 初期位置とその周辺は必ず空ける
  for (const spawn of SPAWNS) {
    if (pointLineDistance(spawn.x, spawn.y, line) < SPAWN_SAFE_RADIUS) return false;
  }

  // 外周に近すぎる線は避ける
  const margin = 55;
  for (const [x, y] of [[line.x1, line.y1], [line.x2, line.y2]]) {
    if (x < margin || x > AREA.w - margin || y < margin || y > AREA.h - margin) return false;
  }

  // 線同士が密集しすぎると詰まりやすいので少し離す
  for (const other of existing) {
    const checks = [
      [line.x1, line.y1], [line.x2, line.y2],
      [other.x1, other.y1], [other.x2, other.y2],
    ];
    if (pointLineDistance(checks[0][0], checks[0][1], other) < 42) return false;
    if (pointLineDistance(checks[1][0], checks[1][1], other) < 42) return false;
    if (pointLineDistance(checks[2][0], checks[2][1], line) < 42) return false;
    if (pointLineDistance(checks[3][0], checks[3][1], line) < 42) return false;
  }

  return true;
}

function makeRandomLine(id) {
  const type = Math.floor(Math.random() * 3);
  const cx = randomBetween(230, AREA.w - 230);
  const cy = randomBetween(105, AREA.h - 105);
  const length = randomBetween(115, 190);
  let angle;

  if (type === 0) angle = 0; // 横
  else if (type === 1) angle = Math.PI / 2; // 縦
  else angle = Math.random() < 0.5 ? Math.PI / 4 : -Math.PI / 4; // 斜め

  const dx = Math.cos(angle) * length / 2;
  const dy = Math.sin(angle) * length / 2;
  return {
    id: `line${id}`,
    x1: Math.round(cx - dx),
    y1: Math.round(cy - dy),
    x2: Math.round(cx + dx),
    y2: Math.round(cy + dy),
  };
}

function generateObstacles() {
  const obstacles = [];
  const targetCount = OBSTACLE_COUNT;
  let attempts = 0;

  while (obstacles.length < targetCount && attempts < 250) {
    attempts += 1;
    const line = makeRandomLine(obstacles.length + 1);
    if (isObstacleSafe(line, obstacles)) obstacles.push(line);
  }

  // まれに生成が足りなかった場合の安全な固定候補
  const fallbacks = [
    { id: 'fallback1', x1: 430, y1: 145, x2: 530, y2: 245 },
    { id: 'fallback2', x1: 430, y1: 395, x2: 530, y2: 295 },
    { id: 'fallback3', x1: 320, y1: 120, x2: 320, y2: 220 },
     ];

  for (const line of fallbacks) {
    if (obstacles.length >= targetCount) break;
    if (isObstacleSafe(line, obstacles)) obstacles.push(line);
  }

  return obstacles;
}


const rooms = new Map();
let saveTimer = null;
let loadedFromDisk = false;

function cloneRoomForSave(room) {
  return {
    code: room.code,
    status: room.status,
    maxPlayers: room.maxPlayers || 2,
    mode: room.mode || 'standard',
    scoreMode: room.scoreMode || 'hit',
    items: room.items || [],
    lastItemSpawnAt: room.lastItemSpawnAt || 0,
    bullets: room.bullets || [],
    winnerSlot: room.winnerSlot ?? null,
    winnerSlots: room.winnerSlots || [],
    message: room.message || '',
    lastTick: Date.now(),
    lastTouched: room.lastTouched || Date.now(),
    roundResetUntil: room.roundResetUntil || 0,
    obstacles: room.obstacles || [],
    tanks: (room.tanks || []).map((tank) => tank && ({
      slot: tank.slot,
      name: tank.name,
      socketId: '',
      token: tank.token,
      connected: false,
      x: tank.x,
      y: tank.y,
      angle: tank.angle,
      hold: false,
      charge: tank.charge || 0,
      bumpCooldown: tank.bumpCooldown || 0,
      score: tank.score || 0,
      alive: tank.alive !== false,
      color: tank.color,
      speedBoostUntil: tank.speedBoostUntil || 0,
      rotateBoostUntil: tank.rotateBoostUntil || 0,
      chargeBoostUntil: tank.chargeBoostUntil || 0,
      sizeUpUntil: tank.sizeUpUntil || 0,
      invisibleUntil: tank.invisibleUntil || 0,
    })),
  };
}

function saveRoomsNow() {
  try {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    const payload = {
      savedAt: Date.now(),
      rooms: Array.from(rooms.values()).map(cloneRoomForSave),
    };
    fs.writeFileSync(SAVE_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('Failed to save rooms:', error);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveRoomsNow();
  }, 350);
}

function touchRoom(room) {
  if (!room) return;
  room.lastTouched = Date.now();
  scheduleSave();
}

function loadRoomsFromDisk() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    const now = Date.now();
    for (const rawRoom of parsed.rooms || []) {
      if (!rawRoom || !rawRoom.code) continue;
      if (now - (rawRoom.lastTouched || parsed.savedAt || now) > ROOM_TTL_MS) continue;
      rawRoom.mode = rawRoom.mode || 'standard';
      rawRoom.scoreMode = rawRoom.scoreMode || 'hit';
      rawRoom.items = rawRoom.items || [];
      rawRoom.lastItemSpawnAt = rawRoom.lastItemSpawnAt || 0;
      rawRoom.tanks = (rawRoom.tanks || []).map((tank) => tank && ({
        ...tank,
        socketId: '',
        connected: false,
        hold: false,
        charge: tank.charge || 0,
        bumpCooldown: 0,
        alive: tank.alive !== false,
        speedBoostUntil: tank.speedBoostUntil || 0,
        rotateBoostUntil: tank.rotateBoostUntil || 0,
        chargeBoostUntil: tank.chargeBoostUntil || 0,
        sizeUpUntil: tank.sizeUpUntil || 0,
        invisibleUntil: tank.invisibleUntil || 0,
      }));
      rawRoom.lastTick = now;
      rawRoom.message = 'サーバー再起動後の部屋を復元しました。各プレイヤーは再接続してください。';
      rooms.set(rawRoom.code, rawRoom);
    }
    loadedFromDisk = rooms.size > 0;
    if (loadedFromDisk) console.log(`Loaded ${rooms.size} room(s) from ${SAVE_FILE}`);
  } catch (error) {
    console.error('Failed to load rooms:', error);
  }
}


function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeTank(slot, name, socketId, token) {
  const spawn = SPAWNS[slot];
  return {
    slot,
    name: name || `P${slot + 1}`,
    socketId,
    token,
    connected: true,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    hold: false,
    charge: 0,
    bumpCooldown: 0,
    score: 0,
    alive: true,
    color: PLAYER_COLORS[slot] || '#facc15',
    speedBoostUntil: 0,
    rotateBoostUntil: 0,
    chargeBoostUntil: 0,
    sizeUpUntil: 0,
    invisibleUntil: 0,
  };
}

function resetPositions(room) {
  room.tanks.forEach((tank) => {
    if (!tank) return;
    tank.x = SPAWNS[tank.slot].x;
    tank.y = SPAWNS[tank.slot].y;
    tank.angle = SPAWNS[tank.slot].angle;
    tank.hold = false;
    tank.charge = 0;
    tank.bumpCooldown = 0;
    tank.alive = true;
    tank.speedBoostUntil = 0;
    tank.rotateBoostUntil = 0;
    tank.chargeBoostUntil = 0;
    tank.sizeUpUntil = 0;
    tank.invisibleUntil = 0;
  });
  room.bullets = [];
  room.roundResetUntil = Date.now() + 700;
}

function publicState(room) {
  return {
    code: room.code,
    area: AREA,
    status: room.status,
    maxPlayers: room.maxPlayers || 2,
    mode: room.mode || 'standard',
    scoreMode: room.scoreMode || 'hit',
    winnerSlot: room.winnerSlot,
    winnerSlots: room.winnerSlots || [],
    winScore: WIN_SCORE,
    chargeTime: CHARGE_TIME,
    chargeBoostTime: CHARGE_BOOST_TIME,
    items: room.items || [],
    obstacles: room.obstacles || [],
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
      alive: t.alive !== false,
      color: t.color,
      speedBoostUntil: t.speedBoostUntil || 0,
      rotateBoostUntil: t.rotateBoostUntil || 0,
      chargeBoostUntil: t.chargeBoostUntil || 0,
      sizeUpUntil: t.sizeUpUntil || 0,
      invisibleUntil: t.invisibleUntil || 0,
      radius: getTankRadius(t),
    })),
    bullets: room.bullets,
    roundResetUntil: room.roundResetUntil,
    message: room.message,
  };
}

function normalizePlayerCount(value) {
  const count = Number(value);
  if (![2, 3, 4].includes(count)) return 2;
  return count;
}

function createRoom(hostName, socket, playerCount = 2, mode = 'standard', scoreMode = 'hit') {
  const code = roomCode();
  const token = cryptoToken();
  const maxPlayers = normalizePlayerCount(playerCount);
  const gameMode = mode === 'extra' ? 'extra' : 'standard';
  const normalizedScoreMode = gameMode === 'extra' && maxPlayers >= 3 && scoreMode === 'survival' ? 'survival' : 'hit';
  const tanks = Array.from({ length: maxPlayers }, () => null);
  tanks[0] = makeTank(0, hostName, socket.id, token);
  const room = {
    code,
    status: 'waiting',
    maxPlayers,
    mode: gameMode,
    scoreMode: normalizedScoreMode,
    tanks,
    bullets: [],
    winnerSlot: null,
    winnerSlots: [],
    message: `参加者を待っています。1/${maxPlayers}人`,
    lastTick: Date.now(),
    roundResetUntil: 0,
    obstacles: generateObstacles(),
    items: [],
    lastItemSpawnAt: 0,
  };
  rooms.set(code, room);
  touchRoom(room);
  socket.join(code);
  socket.data.roomCode = code;
  socket.data.slot = 0;
  socket.data.token = token;
  socket.emit('joined', { code, slot: 0, token });
  emitRoom(room);
}

function joinedCount(room) {
  return room.tanks.filter(Boolean).length;
}

function joinRoom(code, name, socket, token) {
  code = String(code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    socket.emit('errorMessage', '部屋が見つかりません。サーバーが再起動した可能性があります。部屋主が残っていれば同じ部屋IDで復元される場合がありますが、復元できない場合は新しい部屋を作ってください。');
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
  touchRoom(room);
  socket.emit('joined', { code, slot, token: room.tanks[slot].token });

  const count = joinedCount(room);
  if (count >= room.maxPlayers && room.status === 'waiting') {
    startMatch(room);
  } else if (room.status === 'waiting') {
    room.message = `参加者を待っています。${count}/${room.maxPlayers}人`;
  }
  emitRoom(room);
}

function startMatch(room) {
  room.status = 'playing';
  room.winnerSlot = null;
  room.winnerSlots = [];
  room.obstacles = generateObstacles();
  room.items = room.mode === 'extra' ? generateInitialItems(room) : [];
  room.lastItemSpawnAt = Date.now();
  room.tanks.forEach((tank) => {
    if (tank) { tank.score = 0; tank.alive = true; }
  });
  resetPositions(room);
  room.message = `${room.maxPlayers}人対戦開始！${room.mode === 'extra' ? 'エクストラモード：アイテムあり。' : '標準モード。'}${room.scoreMode === 'survival' ? ' 生き残り得点ルール。最後まで残ると1点です。' : ' ヒット得点ルール。'} 長押しで前進、2秒チャージで弾を発射します。`;
  touchRoom(room);
}

function cryptoToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emitRoom(room) {
  io.to(room.code).emit('state', publicState(room));
}

function distancePointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { distance: Math.hypot(px - x1, py - y1), t: 0, nearestX: x1, nearestY: y1 };
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const nearestX = x1 + t * dx;
  const nearestY = y1 + t * dy;
  return { distance: Math.hypot(px - nearestX, py - nearestY), t, nearestX, nearestY };
}

function circleLineHit(cx, cy, radius, line) {
  return distancePointToSegment(cx, cy, line.x1, line.y1, line.x2, line.y2).distance <= radius + OBSTACLE_HALF_WIDTH;
}


function getTankRadius(tank) {
  return TANK_RADIUS * ((tank && tank.sizeUpUntil && tank.sizeUpUntil > Date.now()) ? SIZE_UP_MULTIPLIER : 1);
}

function getTankChargeTime(tank) {
  return (tank && tank.chargeBoostUntil && tank.chargeBoostUntil > Date.now()) ? CHARGE_BOOST_TIME : CHARGE_TIME;
}

function getTankSpeed(tank) {
  return TANK_SPEED * ((tank && tank.speedBoostUntil && tank.speedBoostUntil > Date.now()) ? SPEED_BOOST_MULTIPLIER : 1);
}

function getTankRotateSpeed(tank) {
  return ROTATE_SPEED * ((tank && tank.rotateBoostUntil && tank.rotateBoostUntil > Date.now()) ? ROTATE_BOOST_MULTIPLIER : 1);
}

function tankCanMove(room, tank, nextX, nextY) {
  const radius = getTankRadius(tank);
  if (nextX < radius || nextX > AREA.w - radius) return false;
  if (nextY < radius || nextY > AREA.h - radius) return false;

  for (const obstacle of (room.obstacles || [])) {
    if (circleLineHit(nextX, nextY, radius, obstacle)) return false;
  }

  for (const other of room.tanks) {
    if (!other || other.slot === tank.slot || other.alive === false) continue;
    if (Math.hypot(nextX - other.x, nextY - other.y) < radius + getTankRadius(other)) return false;
  }

  return true;
}


function bumpTankBack(room, tank) {
  if (tank.bumpCooldown > 0) return;

  const backX = -Math.cos(tank.angle);
  const backY = -Math.sin(tank.angle);
  const distances = [BUMP_BACK_DISTANCE, 7, 4, 2];

  for (const distance of distances) {
    const candidateX = tank.x + backX * distance;
    const candidateY = tank.y + backY * distance;
    if (tankCanMove(room, tank, candidateX, candidateY)) {
      tank.x = candidateX;
      tank.y = candidateY;
      break;
    }
  }

  tank.bumpCooldown = BUMP_COOLDOWN;
}

function reflectBulletOnObstacle(bullet, prevX, prevY, line) {
  if (!circleLineHit(bullet.x, bullet.y, BULLET_RADIUS, line)) return false;

  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // Segment normal. Reflect velocity over the line surface.
  let nx = -uy;
  let ny = ux;
  const dot = bullet.vx * nx + bullet.vy * ny;
  bullet.vx = bullet.vx - 2 * dot * nx;
  bullet.vy = bullet.vy - 2 * dot * ny;

  // Push the bullet outside the line so it does not bounce repeatedly in one spot.
  const nearest = distancePointToSegment(bullet.x, bullet.y, line.x1, line.y1, line.x2, line.y2);
  let pushX = bullet.x - nearest.nearestX;
  let pushY = bullet.y - nearest.nearestY;
  const pushLen = Math.hypot(pushX, pushY);
  if (pushLen < 0.001) {
    pushX = prevX - nearest.nearestX;
    pushY = prevY - nearest.nearestY;
  }
  const finalLen = Math.hypot(pushX, pushY) || 1;
  pushX /= finalLen;
  pushY /= finalLen;
  const safeDistance = BULLET_RADIUS + OBSTACLE_HALF_WIDTH + 0.6;
  bullet.x = nearest.nearestX + pushX * safeDistance;
  bullet.y = nearest.nearestY + pushY * safeDistance;

  bullet.bounces += 1;
  return true;
}



const ITEM_TYPES = [
  { type: 'speed', label: '速度UP', color: '#38bdf8' },
  { type: 'rotate', label: '回転速度UP', color: '#c084fc' },
  { type: 'charge', label: 'チャージ短縮', color: '#facc15' },
  { type: 'size', label: '敵巨大化', color: '#fb7185' },
  { type: 'invisible', label: '透明化', color: '#94a3b8' },
];

function isPointSafeForItem(room, x, y) {
  const margin = 48;
  if (x < margin || x > AREA.w - margin || y < margin || y > AREA.h - margin) return false;
  for (const spawn of SPAWNS) {
    if (Math.hypot(x - spawn.x, y - spawn.y) < SPAWN_SAFE_RADIUS - 20) return false;
  }
  for (const obstacle of (room.obstacles || [])) {
    if (pointLineDistance(x, y, obstacle) < 42) return false;
  }
  for (const tank of (room.tanks || [])) {
    if (tank && Math.hypot(x - tank.x, y - tank.y) < 80) return false;
  }
  for (const item of (room.items || [])) {
    if (Math.hypot(x - item.x, y - item.y) < 90) return false;
  }
  return true;
}

function makeItem(room) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const x = Math.round(randomBetween(90, AREA.w - 90));
    const y = Math.round(randomBetween(70, AREA.h - 70));
    if (!isPointSafeForItem(room, x, y)) continue;
    const template = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    return {
      id: cryptoToken(),
      type: template.type,
      label: template.label,
      color: template.color,
      x,
      y,
      bornAt: Date.now(),
    };
  }
  return null;
}

function generateInitialItems(room) {
  const items = [];
  const tempRoom = { ...room, items };
  while (items.length < ITEM_MAX_COUNT) {
    const item = makeItem(tempRoom);
    if (!item) break;
    items.push(item);
  }
  return items;
}

function spawnItemsIfNeeded(room) {
  if (room.mode !== 'extra') return;
  room.items = room.items || [];
  const now = Date.now();
  if (room.items.length >= ITEM_MAX_COUNT) return;
  if (now - (room.lastItemSpawnAt || 0) < ITEM_RESPAWN_MS) return;
  const item = makeItem(room);
  if (item) room.items.push(item);
  room.lastItemSpawnAt = now;
}

function stackEffectUntil(currentUntil, now, durationMs) {
  // 同じ効果を重ねて拾ったら、現在の残り時間に効果時間を加算する。
  // すでに切れている場合は今から durationMs。
  return Math.max(currentUntil || 0, now) + durationMs;
}

function remainingSeconds(until, now) {
  return Math.max(0, Math.ceil(((until || 0) - now) / 1000));
}

function applyItem(room, tank, item) {
  const now = Date.now();
  if (item.type === 'speed') {
    tank.speedBoostUntil = stackEffectUntil(tank.speedBoostUntil, now, SPEED_BOOST_MS);
    room.message = `${tank.name} が速度UPを取得！効果時間 ${remainingSeconds(tank.speedBoostUntil, now)}秒`;
  } else if (item.type === 'rotate') {
    tank.rotateBoostUntil = stackEffectUntil(tank.rotateBoostUntil, now, ROTATE_BOOST_MS);
    room.message = `${tank.name} が回転速度UPを取得！効果時間 ${remainingSeconds(tank.rotateBoostUntil, now)}秒`;
  } else if (item.type === 'charge') {
    tank.chargeBoostUntil = stackEffectUntil(tank.chargeBoostUntil, now, CHARGE_BOOST_MS);
    room.message = `${tank.name} がチャージ短縮を取得！効果時間 ${remainingSeconds(tank.chargeBoostUntil, now)}秒`;
  } else if (item.type === 'size') {
    room.tanks.forEach((other) => {
      if (other && other.slot !== tank.slot) {
        other.sizeUpUntil = stackEffectUntil(other.sizeUpUntil, now, SIZE_UP_MS);
      }
    });
    room.message = `${tank.name} が敵巨大化を取得！相手の巨大化時間を延長しました`;
  } else if (item.type === 'invisible') {
    tank.invisibleUntil = stackEffectUntil(tank.invisibleUntil, now, INVISIBLE_MS);
    room.message = `${tank.name} が透明化を取得！効果時間 ${remainingSeconds(tank.invisibleUntil, now)}秒`;
  }
}

function handleItemPickups(room, tank) {
  if (room.mode !== 'extra' || !room.items || !room.items.length) return;
  const kept = [];
  for (const item of room.items) {
    if (Math.hypot(tank.x - item.x, tank.y - item.y) <= ITEM_PICKUP_RADIUS) {
      applyItem(room, tank, item);
    } else {
      kept.push(item);
    }
  }
  room.items = kept;
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


function aliveTanks(room) {
  return room.tanks.filter((tank) => tank && tank.alive !== false);
}

function resolveSurvivalHit(room, victimSlot, bulletOwner) {
  if (room.status !== 'playing') return;
  const victim = room.tanks[victimSlot];
  if (!victim || victim.alive === false) return;
  victim.alive = false;
  victim.hold = false;
  victim.charge = 0;
  room.bullets = [];

  const alive = aliveTanks(room);
  if (alive.length <= 1) {
    const survivor = alive[0];
    if (survivor) {
      scorePoint(room, survivor.slot);
    } else {
      room.message = '全員撃破されました。ラウンドをリセットします。';
      resetPositions(room);
    }
  } else {
    room.message = `${victim.name} が撃破されました。残り${alive.length}人！最後まで残ると1点です。`;
    room.roundResetUntil = Date.now() + 350;
  }
  touchRoom(room);
}

function scorePoint(room, scorerSlots) {
  if (room.status !== 'playing') return;
  const slots = Array.isArray(scorerSlots) ? scorerSlots : [scorerSlots];
  const scorers = slots
    .map((slot) => room.tanks[slot])
    .filter(Boolean);
  if (!scorers.length) return;

  scorers.forEach((scorer) => { scorer.score += 1; });

  const winners = room.tanks.filter((tank) => tank && tank.score >= WIN_SCORE);
  if (winners.length) {
    const maxScore = Math.max(...winners.map((tank) => tank.score));
    const finalWinners = winners.filter((tank) => tank.score === maxScore);
    room.status = 'finished';
    room.winnerSlot = finalWinners[0].slot;
    room.winnerSlots = finalWinners.map((tank) => tank.slot);
    room.message = `${finalWinners.map((tank) => tank.name).join('・')} の勝利！`;
    room.bullets = [];
    room.tanks.forEach((tank) => {
      if (tank) {
        tank.hold = false;
        tank.charge = 0;
      }
    });
  } else {
    room.message = `${scorers.map((tank) => tank.name).join('・')} が1ポイント！初期配置に戻ります。`;
    resetPositions(room);
  }
  touchRoom(room);
}

function updateRoom(room, dt) {
  if (room.status !== 'playing') return;
  if (room.tanks.filter(Boolean).length < (room.maxPlayers || 2)) return;
  spawnItemsIfNeeded(room);
  if (Date.now() < room.roundResetUntil) return;

  for (const tank of room.tanks) {
    if (!tank) continue;
    if (tank.alive === false) { tank.hold = false; tank.charge = 0; continue; }
    tank.bumpCooldown = Math.max(0, (tank.bumpCooldown || 0) - dt);

    if (tank.hold) {
      const speed = getTankSpeed(tank);
      const nextX = tank.x + Math.cos(tank.angle) * speed * dt;
      const nextY = tank.y + Math.sin(tank.angle) * speed * dt;
      const canMove = tankCanMove(room, tank, nextX, nextY);

      if (canMove) {
        tank.x = nextX;
        tank.y = nextY;
        handleItemPickups(room, tank);
        tank.charge += dt;
      } else {
        bumpTankBack(room, tank);
        // 長押し中は、壁や敵にぶつかって押し戻されてもチャージを維持します。
        // チャージはボタンを離したとき、発射したとき、得点リセット時だけリセットします。
        tank.charge += dt;
      }

      if (tank.charge >= getTankChargeTime(tank)) {
        fireBullet(room, tank);
        tank.charge = 0;
        room.message = `${tank.name} が発射！`;
      }
    } else {
      tank.angle += getTankRotateSpeed(tank) * dt;
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
      for (const obstacle of (room.obstacles || [])) {
        if (reflectBulletOnObstacle(bullet, prevX, prevY, obstacle)) {
          bounced = true;
          break;
        }
      }
    }
    if (bullet.bounces >= bullet.maxBounces) continue;

    let hit = false;
    for (const tank of room.tanks) {
      if (!tank || tank.alive === false) continue;
      const dx = tank.x - bullet.x;
      const dy = tank.y - bullet.y;
      if (Math.hypot(dx, dy) <= getTankRadius(tank) + BULLET_RADIUS) {
        if (room.scoreMode === 'survival') {
          resolveSurvivalHit(room, tank.slot, bullet.owner);
        } else {
          const scorerSlots = tank.slot === bullet.owner
            ? room.tanks.filter((other) => other && other.slot !== bullet.owner).map((other) => other.slot)
            : [bullet.owner];
          scorePoint(room, scorerSlots);
        }
        return; // 得点・リセット時はフィールド上の弾をすべて消した状態を保つ
      }
    }
    if (room.status === 'playing') kept.push(bullet);
  }
  room.bullets = kept;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, playerCount, mode, scoreMode }) => createRoom(name, socket, playerCount, mode, scoreMode));
  socket.on('joinRoom', ({ code, name, token }) => joinRoom(code, name, socket, token));

  socket.on('setHold', ({ hold }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const tank = room.tanks[socket.data.slot];
    if (!tank || tank.token !== socket.data.token) return;
    tank.hold = !!hold;
    if (!tank.hold) tank.charge = 0;
    touchRoom(room);
  });

  socket.on('restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.slot == null) return;
    if (room.status !== 'finished' && socket.data.slot !== 0) return;
    if (room.tanks.filter(Boolean).length < (room.maxPlayers || 2)) {
      room.status = 'waiting';
      room.message = `参加者を待っています。${joinedCount(room)}/${room.maxPlayers || 2}人`;
    } else {
      startMatch(room);
    }
    touchRoom(room);
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
    touchRoom(room);
    // すぐには部屋を消さず、サーバー再起動や一時切断から戻れる余地を残します。
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

setInterval(() => {
  saveRoomsNow();
}, 1000 * 5);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hasActive = (room.tanks || []).some((tank) => tank && tank.connected);
    if (!hasActive && now - (room.lastTouched || now) > ROOM_TTL_MS) rooms.delete(code);
  }
  saveRoomsNow();
}, 1000 * 60);

process.on('SIGTERM', () => {
  saveRoomsNow();
  process.exit(0);
});
process.on('SIGINT', () => {
  saveRoomsNow();
  process.exit(0);
});
process.on('uncaughtException', (error) => {
  console.error(error);
  saveRoomsNow();
  process.exit(1);
});

loadRoomsFromDisk();

server.listen(PORT, () => console.log(`Tank Pixel server running on ${PORT}`));

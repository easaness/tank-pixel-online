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
const ROTATE_SPEED = Math.PI * 0.72;
const BULLET_SPEED = 360;
const BULLET_RADIUS = 6;
const CHARGE_TIME = 2;
const FAST_CHARGE_TIME = CHARGE_TIME / 1.65; // チャージ短縮中は前の倍率相当で約1.2秒
const WIN_SCORE = 5;
const BROADCAST_HZ = 30;
const OBSTACLE_HALF_WIDTH = 7;
const OBSTACLE_COUNT = 3;
const SPAWN_SAFE_RADIUS = 135;
const BUMP_BACK_DISTANCE = 10;
const BUMP_COOLDOWN = 0.12;
const ITEM_RADIUS = 14;
const ITEM_MAX_COUNT = 3;
const ITEM_SPAWN_INTERVAL_MS = 5000;
const ITEM_EFFECT_TYPES = ['speed', 'fastCharge', 'enemyGiant', 'invisible', 'bigBullet', 'fastBullet'];
const ITEM_TYPES = [...ITEM_EFFECT_TYPES, 'random'];
const ITEM_LABELS = {
  speed: '加速',
  fastCharge: 'チャージ短縮',
  enemyGiant: '敵巨大化',
  invisible: '透明化',
  bigBullet: '大きい弾',
  fastBullet: '弾速度上昇',
  random: '？',
};
const ITEM_ICONS = {
  speed: '⚡',
  fastCharge: '⏱',
  enemyGiant: '⬆',
  invisible: '◌',
  bigBullet: '●',
  fastBullet: '➤',
  random: '?',
};
const EFFECT_DURATION_MS = 7000;

function extendTimedEffect(currentUntil, now = Date.now()) {
  return Math.max(currentUntil || 0, now) + EFFECT_DURATION_MS;
}

function effectiveChargeTime(tank, now = Date.now()) {
  return (tank && (tank.fastChargeUntil || 0) > now) ? FAST_CHARGE_TIME : CHARGE_TIME;
}
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


function randomEffectType() {
  return ITEM_EFFECT_TYPES[Math.floor(Math.random() * ITEM_EFFECT_TYPES.length)];
}

function randomItem() {
  // 各通常アイテム + ？アイテムが同じくらいの頻度で出る
  const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
  if (type === 'random') return { type, hidden: true };
  return { type, hidden: false };
}

function isItemPositionSafe(room, x, y) {
  const margin = 70;
  if (x < margin || x > AREA.w - margin || y < margin || y > AREA.h - margin) return false;

  for (const spawn of SPAWNS) {
    if (Math.hypot(x - spawn.x, y - spawn.y) < SPAWN_SAFE_RADIUS * 0.78) return false;
  }

  for (const obstacle of (room.obstacles || [])) {
    if (pointLineDistance(x, y, obstacle) < 38) return false;
  }

  for (const tank of (room.tanks || [])) {
    if (tank && Math.hypot(x - tank.x, y - tank.y) < 70) return false;
  }

  for (const item of (room.items || [])) {
    if (Math.hypot(x - item.x, y - item.y) < 95) return false;
  }

  return true;
}

function spawnRandomItem(room, force = false) {
  room.items = room.items || [];
  const now = Date.now();
  if (!force && now < (room.nextItemAt || 0)) return;
  if (room.items.length >= ITEM_MAX_COUNT) {
    room.nextItemAt = now + ITEM_SPAWN_INTERVAL_MS;
    return;
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const x = Math.round(randomBetween(90, AREA.w - 90));
    const y = Math.round(randomBetween(80, AREA.h - 80));
    if (!isItemPositionSafe(room, x, y)) continue;
    room.items.push({ id: cryptoToken(), x, y, ...randomItem() });
    room.nextItemAt = now + ITEM_SPAWN_INTERVAL_MS;
    return;
  }

  room.nextItemAt = now + 2500;
}

function resetItems(room) {
  room.items = [];
  const now = Date.now();
  room.nextItemAt = now;
  // 初期盤面には必ず最大3個のアイテムを配置します。
  for (let i = 0; i < ITEM_MAX_COUNT; i += 1) {
    spawnRandomItem(room, true);
  }
  room.nextItemAt = now + ITEM_SPAWN_INTERVAL_MS;
}

function itemPublicState(item) {
  if (item.hidden) {
    return { id: item.id, x: item.x, y: item.y, hidden: true, label: '?', icon: '?' };
  }
  return {
    id: item.id,
    x: item.x,
    y: item.y,
    hidden: false,
    type: item.type,
    label: ITEM_LABELS[item.type] || 'アイテム',
    icon: ITEM_ICONS[item.type] || '★',
  };
}

function tankRadius(tank, now = Date.now()) {
  return (tank && (tank.giantUntil || 0) > now) ? TANK_RADIUS * 1.55 : TANK_RADIUS;
}

function bulletRadius(bullet) {
  return bullet.radius || BULLET_RADIUS;
}

function activeEffectsForPublic(tank, now = Date.now()) {
  const effects = [];
  function add(key, name, until) {
    const remainingMs = (until || 0) - now;
    if (remainingMs > 0) {
      effects.push({
        key,
        name,
        remainingMs,
        remaining: Math.max(0, Math.ceil(remainingMs / 1000)),
      });
    }
  }
  add('speed', '加速', tank.speedUntil);
  add('fastCharge', '短縮', tank.fastChargeUntil);
  add('enemyGiant', '巨大化', tank.giantUntil);
  add('invisible', '透明', tank.invisibleUntil);
  add('bigBullet', '大弾', tank.bigBulletUntil);
  add('fastBullet', '速弾', tank.fastBulletUntil);
  return effects;
}

function applyItemEffect(room, tank, item) {
  const now = Date.now();
  const type = item.type === 'random' ? randomEffectType() : item.type;
  const prefix = item.hidden || item.type === 'random' ? '？アイテムを取得：' : `${ITEM_LABELS[type] || 'アイテム'}を取得：`;

  if (type === 'speed') {
    tank.speedUntil = extendTimedEffect(tank.speedUntil, now);
    room.message = `${tank.name} が${prefix}加速！`;
  } else if (type === 'fastCharge') {
    tank.fastChargeUntil = extendTimedEffect(tank.fastChargeUntil, now);
    room.message = `${tank.name} が${prefix}チャージ短縮！`;
  } else if (type === 'enemyGiant') {
    room.tanks.forEach((other) => {
      if (other && other.slot !== tank.slot && other.alive !== false) other.giantUntil = extendTimedEffect(other.giantUntil, now);
    });
    room.message = `${tank.name} が${prefix}敵巨大化！`;
  } else if (type === 'invisible') {
    tank.invisibleUntil = extendTimedEffect(tank.invisibleUntil, now);
    room.message = `${tank.name} が${prefix}透明化！`;
  } else if (type === 'bigBullet') {
    tank.bigBulletUntil = extendTimedEffect(tank.bigBulletUntil, now);
    room.message = `${tank.name} が${prefix}大きい弾！`;
  } else if (type === 'fastBullet') {
    tank.fastBulletUntil = extendTimedEffect(tank.fastBulletUntil, now);
    room.message = `${tank.name} が${prefix}弾速度上昇！`;
  }
  tank.lastItem = ITEM_LABELS[type] || 'アイテム';
}

function checkItemPickup(room, tank) {
  if (!room.items || !room.items.length || tank.alive === false) return;
  const remaining = [];
  for (const item of room.items) {
    if (Math.hypot(tank.x - item.x, tank.y - item.y) <= tankRadius(tank) + ITEM_RADIUS + 2) {
      applyItemEffect(room, tank, item);
      room.nextItemAt = Date.now() + ITEM_SPAWN_INTERVAL_MS;
    } else {
      remaining.push(item);
    }
  }
  room.items = remaining;
}

const rooms = new Map();
let saveTimer = null;
let loadedFromDisk = false;

function cloneRoomForSave(room) {
  return {
    code: room.code,
    status: room.status,
    maxPlayers: room.maxPlayers || 2,
    gameMode: room.gameMode || 'score',
    bullets: room.bullets || [],
    winnerSlot: room.winnerSlot ?? null,
    winnerSlots: room.winnerSlots || [],
    message: room.message || '',
    lastTick: Date.now(),
    lastTouched: room.lastTouched || Date.now(),
    roundResetUntil: room.roundResetUntil || 0,
    obstacles: room.obstacles || [],
    items: room.items || [],
    nextItemAt: room.nextItemAt || 0,
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
      speedUntil: tank.speedUntil || 0,
      fastChargeUntil: tank.fastChargeUntil || 0,
      shield: false,
      giantUntil: tank.giantUntil || 0,
      invisibleUntil: tank.invisibleUntil || 0,
      bigBulletUntil: tank.bigBulletUntil || 0,
      fastBulletUntil: tank.fastBulletUntil || 0,
      lastItem: tank.lastItem || '',
      alive: tank.alive !== false,
      color: tank.color,
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
      rawRoom.tanks = (rawRoom.tanks || []).map((tank) => tank && ({
        ...tank,
        socketId: '',
        connected: false,
        hold: false,
        charge: tank.charge || 0,
        bumpCooldown: 0,
        alive: tank.alive !== false,
        speedUntil: tank.speedUntil || 0,
        fastChargeUntil: tank.fastChargeUntil || 0,
        shield: false,
        giantUntil: tank.giantUntil || 0,
        invisibleUntil: tank.invisibleUntil || 0,
        bigBulletUntil: tank.bigBulletUntil || 0,
        fastBulletUntil: tank.fastBulletUntil || 0,
        lastItem: tank.lastItem || '',
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
    speedUntil: 0,
    fastChargeUntil: 0,
    shield: false,
    giantUntil: 0,
    invisibleUntil: 0,
    bigBulletUntil: 0,
    fastBulletUntil: 0,
    lastItem: '',
    color: PLAYER_COLORS[slot] || '#facc15',
    alive: true,
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
    tank.speedUntil = 0;
    tank.fastChargeUntil = 0;
    tank.shield = false;
    tank.giantUntil = 0;
    tank.invisibleUntil = 0;
    tank.bigBulletUntil = 0;
    tank.fastBulletUntil = 0;
    tank.lastItem = '';
    tank.alive = true;
  });
  room.bullets = [];
  room.roundResetUntil = Date.now() + 700;
}

function publicState(room, viewerSlot = null) {
  const now = Date.now();
  return {
    code: room.code,
    area: AREA,
    status: room.status,
    maxPlayers: room.maxPlayers || 2,
    gameMode: room.gameMode || 'score',
    winnerSlot: room.winnerSlot,
    winnerSlots: room.winnerSlots || [],
    winScore: WIN_SCORE,
    chargeTime: effectiveChargeTime(room.tanks[viewerSlot], now),
    obstacles: room.obstacles || [],
    items: (room.items || []).map(itemPublicState),
    tanks: room.tanks.map((t) => {
      if (!t) return null;
      const invisibleActive = (t.invisibleUntil || 0) > now;
      const hiddenFromViewer = invisibleActive && viewerSlot !== t.slot && t.alive !== false;
      return {
        slot: t.slot,
        name: t.name,
        connected: t.connected,
        // 透明化中は、本人以外には位置・向き・戦車本体を見せません。
        x: hiddenFromViewer ? null : t.x,
        y: hiddenFromViewer ? null : t.y,
        angle: hiddenFromViewer ? 0 : t.angle,
        hiddenFromViewer,
        hold: hiddenFromViewer ? false : t.hold,
        charge: viewerSlot === t.slot ? t.charge : 0,
        score: t.score,
        color: t.color,
        alive: t.alive !== false,
        effects: hiddenFromViewer ? [] : activeEffectsForPublic(t, now),
        shield: false,
        giant: hiddenFromViewer ? false : (t.giantUntil || 0) > now,
        invisible: viewerSlot === t.slot && invisibleActive,
        lastItem: viewerSlot === t.slot ? (t.lastItem || '') : '',
      };
    }),
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


function normalizeGameMode(value) {
  return value === 'survival' ? 'survival' : 'score';
}

function createRoom(hostName, socket, playerCount = 2, gameMode = 'score') {
  const code = roomCode();
  const token = cryptoToken();
  const maxPlayers = normalizePlayerCount(playerCount);
  const normalizedMode = normalizeGameMode(gameMode);
  const tanks = Array.from({ length: maxPlayers }, () => null);
  tanks[0] = makeTank(0, hostName, socket.id, token);
  const room = {
    code,
    status: 'waiting',
    maxPlayers,
    gameMode: normalizedMode,
    tanks,
    bullets: [],
    winnerSlot: null,
    winnerSlots: [],
    message: `参加者を待っています。1/${maxPlayers}人`,
    lastTick: Date.now(),
    roundResetUntil: 0,
    obstacles: generateObstacles(),
    items: [],
    nextItemAt: Date.now() + 1800,
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
  room.tanks.forEach((tank) => {
    if (tank) tank.score = 0;
  });
  resetPositions(room);
  resetItems(room);
  room.message = room.gameMode === 'survival'
    ? `${room.maxPlayers}人サバイバル開始！最後まで生き残った1人が1ポイントです。`
    : `${room.maxPlayers}人対戦開始！地形はランダム生成されました。長押しで前進、2秒チャージで弾を発射します。`;
  touchRoom(room);
}

function cryptoToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emitRoom(room) {
  // 透明化のため、各プレイヤーに見せる状態を個別に生成します。
  for (const tank of room.tanks || []) {
    if (tank && tank.socketId) {
      io.to(tank.socketId).emit('state', publicState(room, tank.slot));
    }
  }
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


function tankCanMove(room, tank, nextX, nextY) {
  const radius = tankRadius(tank);
  if (nextX < radius || nextX > AREA.w - radius) return false;
  if (nextY < radius || nextY > AREA.h - radius) return false;

  for (const obstacle of (room.obstacles || [])) {
    if (circleLineHit(nextX, nextY, radius, obstacle)) return false;
  }

  for (const other of room.tanks) {
    if (!other || other.slot === tank.slot || other.alive === false) continue;
    if (Math.hypot(nextX - other.x, nextY - other.y) < radius + tankRadius(other)) return false;
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
  if (!circleLineHit(bullet.x, bullet.y, bulletRadius(bullet), line)) return false;

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
  const safeDistance = bulletRadius(bullet) + OBSTACLE_HALF_WIDTH + 0.6;
  bullet.x = nearest.nearestX + pushX * safeDistance;
  bullet.y = nearest.nearestY + pushY * safeDistance;

  bullet.bounces += 1;
  return true;
}


function fireBullet(room, tank) {
  const now = Date.now();
  const big = (tank.bigBulletUntil || 0) > now;
  const fast = (tank.fastBulletUntil || 0) > now;
  const radius = big ? BULLET_RADIUS * 1.85 : BULLET_RADIUS;
  const speed = fast ? BULLET_SPEED * 1.45 : BULLET_SPEED;
  const muzzle = tankRadius(tank) + radius + 8;


  room.bullets.push({
    id: cryptoToken(),
    owner: tank.slot,
    x: tank.x + Math.cos(tank.angle) * muzzle,
    y: tank.y + Math.sin(tank.angle) * muzzle,
    vx: Math.cos(tank.angle) * speed,
    vy: Math.sin(tank.angle) * speed,
    radius,
    bounces: 0,
    maxBounces: 5,
  });
}


function aliveTanks(room) {
  return room.tanks.filter((tank) => tank && tank.alive !== false);
}

function endSurvivalRound(room, survivor) {
  if (room.status !== 'playing') return;
  room.bullets = [];

  if (survivor) {
    survivor.score += 1;
    const winners = room.tanks.filter((tank) => tank && tank.score >= WIN_SCORE);
    if (winners.length) {
      const maxScore = Math.max(...winners.map((tank) => tank.score));
      const finalWinners = winners.filter((tank) => tank.score === maxScore);
      room.status = 'finished';
      room.winnerSlot = finalWinners[0].slot;
      room.winnerSlots = finalWinners.map((tank) => tank.slot);
      room.message = `${finalWinners.map((tank) => tank.name).join('・')} の勝利！`;
      room.tanks.forEach((tank) => {
        if (tank) {
          tank.hold = false;
          tank.charge = 0;
        }
      });
      touchRoom(room);
      return;
    }
    room.message = `${survivor.name} が最後まで生き残って1ポイント！次のラウンドへ。`;
  } else {
    room.message = '全員が倒れました。ポイントなしで次のラウンドへ。';
  }

  resetPositions(room);
  resetItems(room);
  touchRoom(room);
}

function eliminateTank(room, tank, reason) {
  if (!tank || tank.alive === false || room.status !== 'playing') return;
  tank.alive = false;
  tank.hold = false;
  tank.charge = 0;
  room.message = `${tank.name} が撃破されました。`;

  const survivors = aliveTanks(room);
  if (survivors.length <= 1) {
    endSurvivalRound(room, survivors[0] || null);
  } else {
    touchRoom(room);
  }
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
    resetItems(room);
  }
  touchRoom(room);
}

function updateRoom(room, dt) {
  if (room.status !== 'playing') return;
  if (room.tanks.filter(Boolean).length < (room.maxPlayers || 2)) return;
  if (Date.now() < room.roundResetUntil) return;

  for (const tank of room.tanks) {
    if (!tank) continue;
    if (tank.alive === false) { tank.hold = false; tank.charge = 0; continue; }
    tank.bumpCooldown = Math.max(0, (tank.bumpCooldown || 0) - dt);

    if (tank.hold) {
      const nowMs = Date.now();
      const speedMultiplier = (tank.speedUntil || 0) > nowMs ? 1.45 : 1;
      const chargeTime = effectiveChargeTime(tank, nowMs);
      const nextX = tank.x + Math.cos(tank.angle) * TANK_SPEED * speedMultiplier * dt;
      const nextY = tank.y + Math.sin(tank.angle) * TANK_SPEED * speedMultiplier * dt;
      const canMove = tankCanMove(room, tank, nextX, nextY);

      if (canMove) {
        tank.x = nextX;
        tank.y = nextY;
        tank.charge += dt;
      } else {
        bumpTankBack(room, tank);
        // 長押し中は、壁や敵にぶつかって押し戻されてもチャージを維持します。
        // チャージはボタンを離したとき、発射したとき、得点リセット時だけリセットします。
        tank.charge += dt;
      }

      checkItemPickup(room, tank);

      if (tank.charge >= chargeTime) {
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

  if (room.status === 'playing') {
    spawnRandomItem(room);
  }

  const kept = [];
  for (const bullet of room.bullets) {
    const prevX = bullet.x;
    const prevY = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    let bounced = false;

    const radius = bulletRadius(bullet);
    if (bullet.x < radius) {
      bullet.x = radius;
      bullet.vx *= -1;
      bounced = true;
    } else if (bullet.x > AREA.w - radius) {
      bullet.x = AREA.w - radius;
      bullet.vx *= -1;
      bounced = true;
    }
    if (bullet.y < radius) {
      bullet.y = radius;
      bullet.vy *= -1;
      bounced = true;
    } else if (bullet.y > AREA.h - radius) {
      bullet.y = AREA.h - radius;
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
      if (Math.hypot(dx, dy) <= tankRadius(tank) + bulletRadius(bullet)) {
        hit = true;
        // 敵・自分を問わず、戦車に当たった弾はその場で消滅します。
        if (room.gameMode === 'survival') {
          eliminateTank(room, tank, tank.slot === bullet.owner ? 'self' : 'hit');
          if (room.status !== 'playing' || Date.now() < room.roundResetUntil) return;
          break;
        }
        const scorerSlots = tank.slot === bullet.owner
          ? room.tanks.filter((other) => other && other.slot !== bullet.owner).map((other) => other.slot)
          : [bullet.owner];
        scorePoint(room, scorerSlots);
        return; // 得点・リセット時はフィールド上の弾をすべて消した状態を保つ
      }
    }
    if (hit) continue;
    if (room.status === 'playing') kept.push(bullet);
  }
  room.bullets = kept;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, playerCount, gameMode }) => createRoom(name, socket, playerCount, gameMode));
  socket.on('joinRoom', ({ code, name, token }) => joinRoom(code, name, socket, token));

  socket.on('setHold', ({ hold }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const tank = room.tanks[socket.data.slot];
    if (!tank || tank.token !== socket.data.token || tank.alive === false) return;
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

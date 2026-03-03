const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/create',   (req, res) => res.sendFile(path.join(__dirname, 'public/create.html')));
app.get('/join',     (req, res) => res.sendFile(path.join(__dirname, 'public/join.html')));
app.get('/joystick', (req, res) => res.sendFile(path.join(__dirname, 'public/joystick.html')));
app.get('/game',     (req, res) => res.sendFile(path.join(__dirname, 'public/game.html')));

const rooms = {};

// ── Constants ──────────────────────────────────────────────────────────────
const GAME_W    = 1920;
const GAME_H    = 1080;
const TANK_W    = 173;
const TANK_H    = 94;
const BULLET_R  = 7;   // radius
const TANK_SPEED    = 3;
const TURN_SPEED    = 1;  // degrees per tick
const BULLET_SPEED  = 20;
const RELOAD_TIME   = 5000; // ms
const HIT_FLASH     = 400;  // ms
const MAX_HITS      = 10;
const TICK_MS       = 1000 / 60;

// Starting positions & angles for each player slot
// Pushed well inside so tanks are fully visible
const SPAWN = {
  A: { x: 120,                     y: 200,                      angle: 45  },
  B: { x: GAME_W - 120 - TANK_W,   y: 200,                      angle: 135 },
  C: { x: 120,                     y: GAME_H - 200 - TANK_H,    angle: 315 },
  D: { x: GAME_W - 120 - TANK_W,   y: GAME_H - 200 - TANK_H,   angle: 225 },
};

const PLAYER_LETTERS = ['A', 'B', 'C', 'D'];

// ── Cube/obstacle generation ───────────────────────────────────────────────
// 5 cubes: top-center, bottom-center, left-center, right-center, dead-center
// Each cube is 120x120px
const CUBE_SIZE = 120;
function generateWalls(playerCount) {
  const C = CUBE_SIZE;
  const midX = GAME_W / 2 - C / 2;
  const midY = GAME_H / 2 - C / 2;

  return [
    // Dead center
    { x: midX,             y: midY,              w: C, h: C },
    // Top center (between A and B)
    { x: midX,             y: 140,               w: C, h: C },
    // Bottom center (between C and D)
    { x: midX,             y: GAME_H - 140 - C,  w: C, h: C },
    // Left center (between A and C)
    { x: 140,              y: midY,              w: C, h: C },
    // Right center (between B and D)
    { x: GAME_W - 140 - C, y: midY,              w: C, h: C },
  ];
}

// ── Utility ────────────────────────────────────────────────────────────────
function generateCode() {
  let code;
  do { code = Math.floor(100000 + Math.random() * 900000).toString(); }
  while (rooms[code]);
  return code;
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const iface of ifaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  const clients = [room.hostWs, ...Object.values(room.playerWs)];
  clients.forEach(ws => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function toRad(deg) { return deg * Math.PI / 180; }

// ── AABB vs AABB collision ─────────────────────────────────────────────────
function rectOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// Circle vs AABB collision
function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const nearX = Math.max(rx, Math.min(cx, rx + rw));
  const nearY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nearX, dy = cy - nearY;
  return dx * dx + dy * dy < r * r;
}

// ── Inactivity timer ───────────────────────────────────────────────────────
function startInactivityTimer(room) {
  clearInactivityTimer(room);
  room.inactivityTimer = setTimeout(() => {
    if (room.state !== 'playing') {
      broadcast(room, { type: 'room_expired' });
      if (room.gameLoop) clearInterval(room.gameLoop);
      delete rooms[room.code];
    }
  }, 15 * 60 * 1000);
}
function clearInactivityTimer(room) {
  if (room.inactivityTimer) { clearTimeout(room.inactivityTimer); room.inactivityTimer = null; }
}

// ── Countdown ─────────────────────────────────────────────────────────────
function startCountdown(room) {
  room.state = 'countdown';
  broadcast(room, { type: 'countdown_start' });
  let count = 7;
  broadcast(room, { type: 'countdown', value: count });
  const iv = setInterval(() => {
    count--;
    if (count >= 0) broadcast(room, { type: 'countdown', value: count });
    if (count < 0) { clearInterval(iv); startGame(room); }
  }, 1000);
}

// ── WebSocket handler ──────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const code = generateCode();
        const { playerCount } = msg; // 2, 3, or 4
        rooms[code] = {
          code, hostWs: ws,
          playerCount: playerCount || 2,
          playerWs: {},      // letter -> ws
          reserved: {},      // letter -> true
          hostNavigating: false,
          state: 'waiting',
          gs: null,
          gameLoop: null,
          inactivityTimer: null,
          walls: [],
        };
        ws.roomCode = code; ws.roomRole = 'host';
        send(ws, { type: 'room_created', code, playerCount: rooms[code].playerCount });
        break;
      }

      case 'observe': {
        const room = rooms[msg.code];
        if (!room) return;
        room.hostWs = ws; room.hostNavigating = false;
        ws.roomCode = msg.code; ws.roomRole = 'host';
        break;
      }

      case 'claim_slot': {
        const { code } = msg;
        const room = rooms[code];
        if (!room)                    { send(ws, { type: 'error', message: 'Room not found' }); return; }
        if (room.state !== 'waiting') { send(ws, { type: 'error', message: 'Game already started' }); return; }

        // Find next free slot up to playerCount
        const letters = PLAYER_LETTERS.slice(0, room.playerCount);
        const player = letters.find(l => !room.reserved[l]);
        if (!player) { send(ws, { type: 'error', message: 'Room is full' }); return; }

        room.reserved[player] = true;
        ws.roomCode = code; ws.roomRole = `claim_${player}`;
        send(ws, { type: 'slot_claimed', player });

        const count = Object.keys(room.reserved).length;
        send(room.hostWs, { type: 'player_joined', count, player, total: room.playerCount });
        break;
      }

      case 'attach': {
        const { code, player } = msg;
        const room = rooms[code];
        if (!room) { send(ws, { type: 'error', message: 'Room not found' }); return; }
        room.playerWs[player] = ws;
        ws.roomCode = code; ws.roomRole = `player${player}`;
        send(ws, { type: 'attached', player });
        if (room.state === 'playing') send(ws, { type: 'game_start' });
        break;
      }

      case 'host_navigating': {
        const room = rooms[ws.roomCode];
        if (room) room.hostNavigating = true;
        break;
      }

      case 'start_game': {
        const room = rooms[ws.roomCode];
        if (!room || ws.roomRole !== 'host') return;
        const needed = PLAYER_LETTERS.slice(0, room.playerCount);
        if (needed.some(l => !room.reserved[l])) {
          send(ws, { type: 'error', message: 'Not all players have joined yet' }); return;
        }
        room.hostNavigating = true;
        startCountdown(room);
        break;
      }

      case 'tank_input': {
        const room = rooms[ws.roomCode];
        if (!room || room.state !== 'playing' || !room.gs) return;
        const letter = ws.roomRole.replace('player', '');
        const tank = room.gs.tanks[letter];
        if (!tank || tank.eliminated) return;
        // msg.input: { forward, backward, left, right, shoot }
        tank.input = msg.input;
        break;
      }

      case 'restart_game': {
        const room = rooms[ws.roomCode];
        if (!room) return;
        if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
        clearInactivityTimer(room);
        startCountdown(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (ws.roomRole === 'host') {
      if (room.hostNavigating) { room.hostWs = null; return; }
      if (room.gameLoop) clearInterval(room.gameLoop);
      broadcast(room, { type: 'player_disconnected', who: 'host' });
      startInactivityTimer(room);
      return;
    }

    const letter = ws.roomRole ? ws.roomRole.replace('player', '') : null;
    if (letter && room.playerWs[letter] === ws) {
      room.playerWs[letter] = null;
      if (room.state === 'playing') {
        if (room.gameLoop) { clearInterval(room.gameLoop); room.gameLoop = null; }
        room.state = 'waiting';
        broadcast(room, { type: 'player_disconnected', who: `Tank ${letter}` });
        startInactivityTimer(room);
      }
    }
  });
});

// ── Game logic ─────────────────────────────────────────────────────────────
function startGame(room) {
  clearInactivityTimer(room);
  room.state = 'playing';
  const letters = PLAYER_LETTERS.slice(0, room.playerCount);

  const tanks = {};
  letters.forEach(l => {
    const sp = SPAWN[l];
    tanks[l] = {
      x: sp.x, y: sp.y,
      angle: sp.angle,   // degrees, 0=right
      hits: 0,
      reloading: false,
      reloadEnd: 0,
      hitFlashEnd: 0,
      eliminated: false,
      input: { forward: false, backward: false, left: false, right: false, shoot: false },
      shootQueued: false,
    };
  });

  const bullets = []; // { id, owner, x, y, angle, bounces }
  let bulletId = 0;

  room.gs = { tanks, bullets };
  room.walls = generateWalls(room.playerCount);
  broadcast(room, { type: 'game_start', walls: room.walls, playerCount: room.playerCount });

  room.gameLoop = setInterval(() => {
    const now = Date.now();
    const gs = room.gs;

    // ── Update tanks ──────────────────────────────────────────────────────
    letters.forEach(l => {
      const t = gs.tanks[l];
      if (t.eliminated) return;

      const inp = t.input;

      // Turning
      if (inp.left)  t.angle = (t.angle - TURN_SPEED + 360) % 360;
      if (inp.right) t.angle = (t.angle + TURN_SPEED) % 360;

      // Movement
      if (inp.forward || inp.backward) {
        const dir = inp.forward ? 1 : -1;
        const rad = toRad(t.angle);
        const nx = t.x + Math.cos(rad) * TANK_SPEED * dir;
        const ny = t.y + Math.sin(rad) * TANK_SPEED * dir;

        // Boundary clamp using tank CENTER so rotation never causes clipping
        // Half-diagonal of 173x94 tank = ~99px, use 105px safe radius
        const SAFE = 105;
        const TOP_SAFE = SAFE + 80; // extra for scoreboard
        const centerNX = nx + TANK_W / 2;
        const centerNY = ny + TANK_H / 2;
        const clampedCX = Math.max(SAFE, Math.min(GAME_W - SAFE, centerNX));
        const clampedCY = Math.max(TOP_SAFE, Math.min(GAME_H - SAFE, centerNY));
        const cx = clampedCX - TANK_W / 2;
        const cy = clampedCY - TANK_H / 2;

        // Use a tighter collision body (centered, smaller than full sprite)
        // so tanks don't get blocked by nearby cubes they aren't really touching
        const BODY_W = 100, BODY_H = 70;
        const bodyOffX = (TANK_W - BODY_W) / 2;
        const bodyOffY = (TANK_H - BODY_H) / 2;
        const bx = cx + bodyOffX, by = cy + bodyOffY;

        // Cube collision
        const wallBlocked = room.walls.some(w => rectOverlap(bx, by, BODY_W, BODY_H, w.x, w.y, w.w, w.h));
        // Tank-vs-tank body collision
        const tankBlocked = letters.some(other => {
          if (other === l) return false;
          const o = gs.tanks[other];
          if (o.eliminated) return false;
          const obx = o.x + bodyOffX, oby = o.y + bodyOffY;
          return rectOverlap(bx, by, BODY_W, BODY_H, obx, oby, BODY_W, BODY_H);
        });
        if (!wallBlocked && !tankBlocked) { t.x = cx; t.y = cy; }
      }

      // Shooting
      if (inp.shoot && !t.reloading && !t.shootQueued) {
        t.shootQueued = true;
      }
      if (t.shootQueued) {
        t.shootQueued = false;
        t.reloading = true;
        t.reloadEnd = now + RELOAD_TIME;
        // Spawn bullet well ahead of barrel tip — enough clearance to never self-hit on spawn
        const rad = toRad(t.angle);
        const spawnDist = TANK_W / 2 + 30; // 30px clear of tank edge
        const bx = t.x + TANK_W / 2 + Math.cos(rad) * spawnDist;
        const by = t.y + TANK_H / 2 + Math.sin(rad) * spawnDist;
        // immunity: bullet cannot hit its own owner for first 20 frames
        bullets.push({ id: bulletId++, owner: l, x: bx, y: by, angle: t.angle, bounces: 0, frames: 0 });
      }
      if (t.reloading && now >= t.reloadEnd) {
        t.reloading = false;
      }
    });

    // ── Update bullets ────────────────────────────────────────────────────
    const toRemove = new Set();
    const hits = []; // { tank, bullet }

    bullets.forEach(b => {
      if (toRemove.has(b.id)) return;
      const rad = toRad(b.angle);
      b.x += Math.cos(rad) * BULLET_SPEED;
      b.y += Math.sin(rad) * BULLET_SPEED;

      // Out of bounds
      if (b.x < 0 || b.x > GAME_W || b.y < 0 || b.y > GAME_H) {
        toRemove.add(b.id); return;
      }

      // Cube bounce
      let wallHit = false;
      for (const w of room.walls) {
        if (circleRect(b.x, b.y, BULLET_R, w.x, w.y, w.w, w.h)) {
          if (b.bounces >= 5) { toRemove.add(b.id); break; }
          const overlapLeft   = (b.x + BULLET_R) - w.x;
          const overlapRight  = (w.x + w.w) - (b.x - BULLET_R);
          const overlapTop    = (b.y + BULLET_R) - w.y;
          const overlapBottom = (w.y + w.h) - (b.y - BULLET_R);
          const minH = Math.min(overlapLeft, overlapRight);
          const minV = Math.min(overlapTop, overlapBottom);
          if (minH < minV) {
            b.angle = (180 - b.angle + 360) % 360;
          } else {
            b.angle = (360 - b.angle + 360) % 360;
          }
          b.bounces++;
          const rad2 = toRad(b.angle);
          b.x += Math.cos(rad2) * BULLET_SPEED;
          b.y += Math.sin(rad2) * BULLET_SPEED;
          b.wallHit = true;
          wallHit = true;
          break;
        }
      }
      if (toRemove.has(b.id)) return;

      // Increment bullet frame counter
      b.frames = (b.frames || 0) + 1;

      // Tank hit detection — tight circle check, owner immune for first 20 frames
      const HIT_RADIUS = 38; // tighter than full bounding box — feels accurate
      letters.forEach(l => {
        const t = gs.tanks[l];
        if (t.eliminated) return;
        if (l === b.owner && b.frames < 20) return; // owner immunity window
        // Use circle vs circle: distance between bullet center and tank center
        const tcx = t.x + TANK_W / 2;
        const tcy = t.y + TANK_H / 2;
        const dx = b.x - tcx;
        const dy = b.y - tcy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < BULLET_R + HIT_RADIUS) {
          hits.push({ tank: l, bullet: b });
          toRemove.add(b.id);
        }
      });
    });

    // Apply hits
    const hitEvents = [];
    hits.forEach(({ tank, bullet }) => {
      const t = gs.tanks[tank];
      if (t.eliminated) return;
      t.hits++;
      t.hitFlashEnd = now + HIT_FLASH;
      hitEvents.push({ tank, shooter: bullet.owner, hits: t.hits });
      if (t.hits >= MAX_HITS) {
        t.eliminated = true;
        // Notify that player's joystick
        const joystickWs = room.playerWs[tank];
        if (joystickWs && joystickWs.readyState === 1) {
          joystickWs.send(JSON.stringify({ type: 'eliminated' }));
        }
      }
    });

    // Remove spent bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (toRemove.has(bullets[i].id)) bullets.splice(i, 1);
    }

    // Check win condition
    const alive = letters.filter(l => !gs.tanks[l].eliminated);
    let winner = null;
    if (alive.length === 1) winner = alive[0];
    if (alive.length === 0) winner = 'draw';
    // Edge case: if playerCount is 1 (shouldn't happen but safety)
    if (letters.length === 1 && gs.tanks[letters[0]].eliminated) winner = letters[0];

    // Build state snapshot
    const tankState = {};
    letters.forEach(l => {
      const t = gs.tanks[l];
      tankState[l] = {
        x: Math.round(t.x), y: Math.round(t.y),
        angle: Math.round(t.angle * 10) / 10,
        hits: t.hits,
        reloading: t.reloading,
        hitFlash: now < t.hitFlashEnd,
        eliminated: t.eliminated,
      };
    });

    const bulletState = bullets.map(b => ({
      id: b.id, owner: b.owner,
      x: Math.round(b.x), y: Math.round(b.y),
      wallHit: b.wallHit || false,
    }));
    // Reset wallHit flags after broadcasting
    bullets.forEach(b => { b.wallHit = false; });

    // Send game_over FIRST if there's a winner, so client doesn't get a trailing state update
    if (winner !== null) {
      clearInterval(room.gameLoop); room.gameLoop = null;
      room.state = 'finished';
      // Still send final state so positions are up to date
      broadcast(room, {
        type: 'game_state',
        tanks: tankState,
        bullets: bulletState,
        hitEvents,
      });
      broadcast(room, { type: 'game_over', winner });
      startInactivityTimer(room);
      return;
    }

    broadcast(room, {
      type: 'game_state',
      tanks: tankState,
      bullets: bulletState,
      hitEvents,
    });

  }, TICK_MS);
}

const PORT = 3001; // Different port from SockPong
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n🎮 SockTank Server Running!`);
  console.log(`\n   Game screen: http://localhost:${PORT}`);
  console.log(`   Phones:      http://${ip}:${PORT}/join\n`);
});

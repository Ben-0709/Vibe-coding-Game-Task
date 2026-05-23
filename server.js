'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const os   = require('os');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
//  NETWORK
// ══════════════════════════════════════════════════════
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  return ips.length ? ips : ['localhost'];
}
const localIPs  = getLocalIPs();
const primaryIP = localIPs[0];

// ══════════════════════════════════════════════════════
//  CHARACTER CLASSES  — server is the sole authority
// ══════════════════════════════════════════════════════
const CHAR_CLASSES = {
  striker: { maxHp:100, speed:5.0, atk:12, jump:-14, atkRange:85,  atkCd:28 },
  titan:   { maxHp:150, speed:3.2, atk:20, jump:-11, atkRange:100, atkCd:40 },
  phantom: { maxHp:75,  speed:7.5, atk:9,  jump:-17, atkRange:70,  atkCd:18 },
  bruiser: { maxHp:120, speed:4.0, atk:17, jump:-12, atkRange:95,  atkCd:34 },
};
const VALID_CLASSES = new Set(Object.keys(CHAR_CLASSES));

// ══════════════════════════════════════════════════════
//  PHYSICS / ARENA CONSTANTS
// ══════════════════════════════════════════════════════
const ARENA_W    = 1200;
const GROUND_Y   = 510;
const PLAYER_H   = 64;
const PLAYER_W   = 28;
const GRAVITY    = 0.55;
const HURT_INV   = 28;
const MAX_P      = 8;
const MIN_P      = 2;

// ══════════════════════════════════════════════════════
//  ANTI-CHEAT
// ══════════════════════════════════════════════════════
const rateLimits = new Map();     // socketId → {count, resetAt}
const MAX_RATE   = 130;           // inputs per second

function checkRate(sid) {
  const now = Date.now();
  let r = rateLimits.get(sid);
  if (!r || now > r.resetAt) { r = { count:0, resetAt: now+1000 }; rateLimits.set(sid, r); }
  return ++r.count <= MAX_RATE;
}

// Only allow strict booleans — no truthy tricks
function cleanInput(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return {
    left:   raw.left   === true,
    right:  raw.right  === true,
    jump:   raw.jump   === true,
    attack: raw.attack === true,
  };
}

function cleanName(raw) {
  if (typeof raw !== 'string') return 'Fighter';
  return raw.replace(/[<>&"'\\]/g, '').trim().slice(0, 16) || 'Fighter';
}

function cleanClass(raw) {
  return VALID_CLASSES.has(raw) ? raw : 'striker';
}

function cleanColor(raw) {
  // Only accept 6-digit hex colours — nothing executable
  return (typeof raw === 'string' && /^#[0-9A-Fa-f]{6}$/.test(raw)) ? raw : '#FF6B6B';
}

// ══════════════════════════════════════════════════════
//  PLAYER FACTORY
// ══════════════════════════════════════════════════════
function makePlayer(id, name, charClass, color, x, isBot = false) {
  const cls = CHAR_CLASSES[charClass];
  return {
    id, name: cleanName(name), charClass, color: cleanColor(color),
    x, y: GROUND_Y - PLAYER_H,
    vx: 0, vy: 0, onGround: true, facing: 1,
    hp: cls.maxHp, maxHp: cls.maxHp,
    speed: cls.speed, atk: cls.atk, jump: cls.jump,
    atkRange: cls.atkRange, atkCd: cls.atkCd,
    state: 'idle',
    attackCooldown: 0, invincible: 0,
    kills: 0, damageDealt: 0,
    isBot, input: {},
  };
}

// ══════════════════════════════════════════════════════
//  AI BOT  (easy / normal / hard)
// ══════════════════════════════════════════════════════
class AIBot {
  constructor(id, difficulty) {
    this.id = id;
    const cfg = {
      easy:   { delay:55, acc:0.30, aggr:0.25, jumpP:0.02, wanderP:0.65 },
      normal: { delay:24, acc:0.65, aggr:0.60, jumpP:0.08, wanderP:0.15 },
      hard:   { delay: 6, acc:0.93, aggr:0.92, jumpP:0.20, wanderP:0.00 },
    }[difficulty] || {};
    Object.assign(this, cfg);
    this.timer    = Math.floor(Math.random() * this.delay);
    this.cached   = {};
    this.wanderDir = 1;
    this.wanderT   = 0;
  }

  input(self, all) {
    if (--this.timer > 0) return this.cached;
    this.timer = this.delay + Math.floor(Math.random() * 8);
    const alive   = all.filter(t => t.id !== self.id && t.hp > 0);
    if (!alive.length) return (this.cached = {});
    const target  = alive.reduce((c, t) =>
      Math.abs(t.x - self.x) < Math.abs(c.x - self.x) ? t : c);
    const dx = target.x - self.x, adx = Math.abs(dx);
    const inRng = adx < self.atkRange + 15;
    this.cached = this[`_${this.id.includes('easy') ? 'easy' : this.difficulty}`]
      ? this[`_${this.difficulty}`](self, target, dx, adx, inRng)
      : this._normal(self, target, dx, adx, inRng);
    return this.cached;
  }

  _easy(self, target, dx, adx, inRng) {
    const i = { left:false, right:false, jump:false, attack:false };
    if (Math.random() < this.wanderP) {
      if (--this.wanderT <= 0) { this.wanderDir = Math.random()<.5?-1:1; this.wanderT=40+Math.random()*50; }
      i.left = this.wanderDir < 0; i.right = this.wanderDir > 0;
    } else if (Math.random() < this.aggr) {
      i.left = dx < -60; i.right = dx > 60;
    }
    if (inRng && Math.random() < this.acc && self.attackCooldown === 0) i.attack = true;
    if (self.onGround && Math.random() < this.jumpP) i.jump = true;
    return i;
  }

  _normal(self, target, dx, adx, inRng) {
    const i = { left:false, right:false, jump:false, attack:false };
    i.left = dx < -25; i.right = dx > 25;
    if (inRng && self.attackCooldown === 0 && Math.random() < this.acc) i.attack = true;
    if (self.onGround && Math.random() < this.jumpP) i.jump = true;
    if ((self.x < 100 || self.x > ARENA_W-100) && self.onGround && Math.random()<.3) i.jump = true;
    return i;
  }

  _hard(self, target, dx, adx, inRng) {
    const i = { left:false, right:false, jump:false, attack:false };
    // Dodge if target is mid-attack and close
    if (target.state === 'attack' && adx < 130) {
      i.left = dx > 0; i.right = dx < 0;
      if (self.onGround && Math.random() < 0.5) i.jump = true;
      return i;
    }
    // Escape corner
    if ((self.x < 110 || self.x > ARENA_W-110) && self.onGround && Math.random()<.45) {
      i.jump = true; i.left = self.x > 600; i.right = self.x <= 600;
      return i;
    }
    // Engage
    i.left = dx < 0; i.right = dx > 0;
    if (inRng && self.attackCooldown === 0) i.attack = true;
    if (self.onGround && !inRng && Math.random() < this.jumpP) i.jump = true;
    return i;
  }
}

// ══════════════════════════════════════════════════════
//  SHARED PLAYER PHYSICS TICK
// ══════════════════════════════════════════════════════
function tickPlayer(p, all, effects) {
  const inp = p.input || {};

  if (inp.left)        { p.vx = -p.speed; p.facing = -1; }
  else if (inp.right)  { p.vx =  p.speed; p.facing =  1; }
  else { p.vx *= 0.72; if (Math.abs(p.vx) < 0.2) p.vx = 0; }

  if (p.state !== 'attack' && p.state !== 'hurt') {
    if (!p.onGround)               p.state = 'jump';
    else if (Math.abs(p.vx) > 0.5) p.state = 'walk';
    else                           p.state = 'idle';
  }

  if (inp.jump && p.onGround) {
    p.vy = p.jump; p.onGround = false; p.state = 'jump';
  }

  p.vy += GRAVITY; p.x += p.vx; p.y += p.vy;

  if (p.y >= GROUND_Y - PLAYER_H) { p.y = GROUND_Y - PLAYER_H; p.vy = 0; p.onGround = true; }
  p.x = Math.max(PLAYER_W, Math.min(ARENA_W - PLAYER_W, p.x));

  if (inp.attack && p.attackCooldown <= 0) {
    p.attackCooldown = p.atkCd;
    p.state = 'attack';
    for (const other of all) {
      if (other.id === p.id || other.hp <= 0 || other.invincible > 0) continue;
      const dx = other.x - p.x;
      const dy = Math.abs((other.y + PLAYER_H/2) - (p.y + PLAYER_H/2));
      if (Math.abs(dx) < p.atkRange && dy < PLAYER_H && Math.sign(dx) === p.facing) {
        const dmg = p.atk + Math.floor(Math.random() * 6);
        other.hp = Math.max(0, other.hp - dmg);
        other.invincible = HURT_INV;
        other.vx = p.facing * 7; other.vy = -4.5;
        other.state = 'hurt';
        p.damageDealt = (p.damageDealt||0) + dmg;
        effects.push({ x: other.x, y: other.y + PLAYER_H*0.3, color: p.color, dmg });
      }
    }
  }

  if (p.attackCooldown > 0) { p.attackCooldown--; if (p.attackCooldown===0 && p.state==='attack') p.state=p.onGround?'idle':'jump'; }
  if (p.invincible   > 0) { p.invincible--;    if (p.invincible   ===0 && p.state==='hurt')   p.state=p.onGround?'idle':'jump'; }
}

// ══════════════════════════════════════════════════════
//  SNAPSHOT (never send internal fields to clients)
// ══════════════════════════════════════════════════════
function snap(p) {
  return { id:p.id, name:p.name, color:p.color, charClass:p.charClass,
           x:p.x, y:p.y, vx:p.vx, facing:p.facing,
           hp:p.hp, maxHp:p.maxHp, state:p.state, invincible:p.invincible,
           kills:p.kills, attackCooldown:p.attackCooldown, isBot:p.isBot };
}
function snapAll(players) {
  return Object.fromEntries(Object.entries(players).map(([id,p])=>[id,snap(p)]));
}

// ══════════════════════════════════════════════════════
//  MULTIPLAYER ROOM  (server-wide)
// ══════════════════════════════════════════════════════
const MP = { players:{}, phase:'lobby', roundTimer:null };

function mpReset() {
  const list = Object.values(MP.players);
  const step = list.length<=1 ? 400 : (ARENA_W-300)/(list.length-1);
  list.forEach((p,i)=>{
    p.x=150+i*step; p.y=GROUND_Y-PLAYER_H;
    p.vx=p.vy=0; p.onGround=true; p.hp=p.maxHp;
    p.state='idle'; p.attackCooldown=p.invincible=0; p.input={};
    p.facing=p.x<ARENA_W/2?1:-1;
  });
}
function mpStart() {
  clearTimeout(MP.roundTimer); MP.phase='fighting'; mpReset();
  io.to('mp').emit('roundStart',{ players:snapAll(MP.players) });
}
function mpCheckWin() {
  if (MP.phase!=='fighting') return;
  const alive=Object.values(MP.players).filter(p=>p.hp>0);
  if (alive.length<=1 && Object.keys(MP.players).length>=MIN_P) mpEnd(alive[0]||null);
}
function mpEnd(winner) {
  if (MP.phase==='roundEnd') return;
  MP.phase='roundEnd'; if (winner) winner.kills++;
  const scores=Object.values(MP.players).sort((a,b)=>b.kills-a.kills)
    .map(p=>({ id:p.id,name:p.name,color:p.color,charClass:p.charClass,kills:p.kills }));
  io.to('mp').emit('roundEnd',{ winner:winner?snap(winner):null, players:snapAll(MP.players), scores });
  MP.roundTimer=setTimeout(()=>{
    if (Object.keys(MP.players).length>=MIN_P) mpStart();
    else { MP.phase='lobby'; io.to('mp').emit('backToLobby',{ players:snapAll(MP.players) }); }
  }, 6000);
}

// Main game loop – multiplayer
setInterval(()=>{
  if (MP.phase!=='fighting') return;
  const list=Object.values(MP.players), fx=[];
  list.forEach(p=>{ if (p.hp<=0){p.state='dead';return;} tickPlayer(p,list,fx); });
  mpCheckWin();
  io.to('mp').emit('tick',{ players:snapAll(MP.players), effects:fx });
}, 1000/60);

// ══════════════════════════════════════════════════════
//  SOLO ROOMS  (training / demo)  — one per socket
// ══════════════════════════════════════════════════════
const soloRooms = new Map();

function soloCleanup(sid) {
  const r=soloRooms.get(sid);
  if (r) { clearInterval(r.interval); soloRooms.delete(sid); }
}

function soloReset(room) {
  const list=Object.values(room.players);
  list.forEach((p,i)=>{
    p.x=280+i*640; p.y=GROUND_Y-PLAYER_H;
    p.vx=p.vy=0; p.onGround=true; p.hp=p.maxHp;
    p.state='idle'; p.attackCooldown=p.invincible=0; p.input={};
    p.facing=i===0?1:-1;
  });
  room.phase='fighting';
}

function soloStart(sid, room) {
  soloReset(room);
  room.interval = setInterval(()=>{
    const skt = io.sockets.sockets.get(sid);
    if (!skt) { soloCleanup(sid); return; }
    if (room.phase!=='fighting') return;

    const list=Object.values(room.players), fx=[];
    list.forEach(p=>{
      if (p.hp<=0){p.state='dead';return;}
      if (p.isBot) {
        const ai=room.bots.get(p.id);
        if (ai) p.input=ai.input(p,list);
      }
      tickPlayer(p,list,fx);
    });

    skt.emit('soloTick',{ players:snapAll(room.players), effects:fx });

    const alive=list.filter(p=>p.hp>0);
    if (alive.length<=1) {
      room.phase='roundEnd';
      clearInterval(room.interval); room.interval=null;
      const w=alive[0]||null; if(w) w.kills++;
      skt.emit('soloRoundEnd',{ winner:w?snap(w):null, players:snapAll(room.players), mode:room.mode });
      const delay = room.mode==='demo' ? 3500 : 5000;
      room.restartTimer = setTimeout(()=>{
        if (!soloRooms.has(sid)) return;
        soloStart(sid,room);
        const skt2=io.sockets.sockets.get(sid);
        if (skt2) skt2.emit('soloRoundStart',{ players:snapAll(room.players) });
      }, delay);
    }
  }, 1000/60);
}

// ══════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════
io.on('connection', socket=>{
  const sid = socket.id;
  console.log(`[+] ${sid}`);
  socket.emit('init',{ phase:MP.phase, players:snapAll(MP.players), serverIP:primaryIP, port:PORT });

  // ── MULTIPLAYER JOIN ──
  socket.on('join',({ name,charClass,color })=>{
    if (Object.keys(MP.players).length>=MAX_P) return socket.emit('joinError','Game is full!');
    if (MP.phase!=='lobby') return socket.emit('joinError','Round in progress — wait for next round.');
    const idx=Object.keys(MP.players).length;
    const p=makePlayer(sid, name, cleanClass(charClass), cleanColor(color), 160+idx*160);
    MP.players[sid]=p; socket.join('mp');
    io.to('mp').emit('playerJoined',snap(p));
    io.to('mp').emit('playersSync',snapAll(MP.players));
    console.log(`[+] ${p.name} (${p.charClass}) joined MP`);
  });

  // ── INPUT ──
  socket.on('input', raw=>{
    if (!checkRate(sid)) return;  // Anti-cheat: rate limit
    const ci = cleanInput(raw);   // Anti-cheat: sanitize
    if (MP.players[sid] && MP.phase==='fighting') MP.players[sid].input=ci;
    const room=soloRooms.get(sid);
    if (room && room.phase==='fighting') {
      const sp=room.players[sid];
      if (sp) sp.input=ci;
    }
  });

  // ── START MULTIPLAYER ──
  socket.on('startGame',()=>{
    if (Object.keys(MP.players).length<MIN_P)
      return socket.emit('joinError',`Need at least ${MIN_P} players.`);
    mpStart();
  });

  // ── TRAINING MODE ──
  socket.on('startTraining',({ name,charClass,color,difficulty })=>{
    soloCleanup(sid);
    const diff=['easy','normal','hard'].includes(difficulty)?difficulty:'normal';
    const room={ mode:'training', phase:'lobby', players:{}, bots:new Map(), interval:null, restartTimer:null };

    // Human
    const p=makePlayer(sid,name,cleanClass(charClass),cleanColor(color),280,false);
    room.players[sid]=p;

    // Bot opponent (random class)
    const botClasses=['striker','titan','phantom','bruiser'];
    const botColors=['#4ECDC4','#FF9F43','#A855F7','#FF6B9D'];
    const bClass=botClasses[Math.floor(Math.random()*botClasses.length)];
    const bColor=botColors [Math.floor(Math.random()*botColors.length)];
    const botId=`bot_${sid}`;
    const bot=makePlayer(botId,`AI [${diff.toUpperCase()}]`,bClass,bColor,920,true);
    room.players[botId]=bot;
    room.bots.set(botId, new AIBot(botId,diff));

    soloRooms.set(sid,room);
    soloStart(sid,room);
    socket.emit('trainingStarted',{ players:snapAll(room.players), difficulty:diff });
    console.log(`[T] Training: ${p.name} vs AI (${diff})`);
  });

  // ── DEMO MODE ──
  socket.on('watchDemo',()=>{
    soloCleanup(sid);
    const room={ mode:'demo', phase:'lobby', players:{}, bots:new Map(), interval:null, restartTimer:null };
    const fighters=[
      { id:`da_${sid}`, name:'APEX',  cls:'striker', clr:'#FF6B6B', x:280 },
      { id:`db_${sid}`, name:'NEXUS', cls:'bruiser', clr:'#4ECDC4', x:920 },
    ];
    fighters.forEach(f=>{
      const p=makePlayer(f.id,f.name,f.cls,f.clr,f.x,true);
      room.players[f.id]=p;
      room.bots.set(f.id, new AIBot(f.id,'hard'));
    });
    soloRooms.set(sid,room);
    soloStart(sid,room);
    socket.emit('demoStarted',{ players:snapAll(room.players) });
    console.log(`[D] Demo started for ${sid}`);
  });

  // ── EXIT SOLO ──
  socket.on('exitSolo',()=>{ soloCleanup(sid); socket.emit('backToMenu'); });

  // ── DISCONNECT ──
  socket.on('disconnect',()=>{
    const p=MP.players[sid];
    if (p) {
      delete MP.players[sid];
      io.to('mp').emit('playerLeft',sid);
      io.to('mp').emit('playersSync',snapAll(MP.players));
      if (MP.phase==='fighting') mpCheckWin();
      console.log(`[-] ${p.name} left MP`);
    }
    soloCleanup(sid);
    rateLimits.delete(sid);
  });
});

// ══════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════
server.listen(PORT,'0.0.0.0',()=>{
  const L='═'.repeat(48);
  console.log(`\n╔${L}╗`);
  console.log(`║${"  ⚔  BEN'S MORTAL KOMBAT — SERVER  ⚔  ".padEnd(48)}║`);
  console.log(`╠${L}╣`);
  console.log(`║  Local:   http://localhost:${PORT}${' '.repeat(48-28)}║`);
  localIPs.forEach(ip=>{
    const s=`Network: http://${ip}:${PORT}`;
    console.log(`║  ${s}${' '.repeat(Math.max(0,48-2-s.length))}║`);
  });
  console.log(`╠${L}╣`);
  console.log(`║  Modes: Multiplayer · Training · Demo           ║`);
  console.log(`║  Opening browser automatically…                 ║`);
  console.log(`╚${L}╝\n`);

  // Auto-open browser after a short delay so the server is fully ready
  setTimeout(()=>{
    const { exec } = require('child_process');
    exec(`start http://localhost:${PORT}`);
  }, 800);
});

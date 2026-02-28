const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 26213; 
const APP_VERSION = "1.1"; 

// Хранилище данных
let players = {}; 
let database = {}; // { "Nick": { score: 0, ip: "127.0.0.1" } }
let bullets = [];
let loot = [];

// Карта стен
const MAP_OBSTACLES = [
    { x: 10, z: 10, w: 4, d: 4 }, { x: -10, z: -10, w: 5, d: 2 },
    { x: 15, z: -5, w: 2, d: 8 }, { x: -12, z: 8, w: 6, d: 1 },
    { x: 0, z: 15, w: 10, d: 1 }
];

// БАЛАНС (cd - задержка мс, auto - можно ли зажимать)
const WEAPONS = {
    pistol:   { clip: 17, reload: 1500, dmg: 18, cd: 250,  auto: false },
    shotgun:  { clip: 5,  reload: 2500, dmg: 12, cd: 900,  auto: false }, 
    rifle:    { clip: 30, reload: 2000, dmg: 9,  cd: 120,  auto: true },
    sniper:   { clip: 5,  reload: 3000, dmg: 75, cd: 1500, auto: false }, 
    smg:      { clip: 40, reload: 1500, dmg: 6,  cd: 90,   auto: true }
};

// ЕЖЕДНЕВНАЯ ОЧИСТКА В 00:00
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() === 0) {
        database = {};
        players = {};
        io.emit('version_error', 'Server Reset (Daily Maintenance)');
        console.log("[SYSTEM] Ежедневная очистка базы данных выполнена.");
    }
}, 1000);

// Спавн лута (патроны)
setInterval(() => {
    if (loot.length < 6) {
        loot.push({ id: Math.random(), x: (Math.random()-0.5)*40, z: (Math.random()-0.5)*40 });
    }
}, 4000);

// Админ-панель
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (input) => {
    const [cmd, target, val] = input.trim().split(' ');
    if (cmd === 'kill') Object.values(players).forEach(p => { if(p.name === target) p.hp = 0; });
    if (cmd === 'delete') { delete database[target]; console.log(`[DB] Игрок ${target} удален.`); }
    if (cmd === 'list') console.table(database);
});

// Проверка коллизий
function canMove(x, z) {
    for (let o of MAP_OBSTACLES) {
        if (x > o.x - o.w/2 - 0.6 && x < o.x + o.w/2 + 0.6 &&
            z > o.z - o.d/2 - 0.6 && z < o.z + o.d/2 + 0.6) return false;
    }
    return true;
}

io.on('connection', (socket) => {
    const ip = socket.handshake.address;

    socket.on('join', (data) => {
        if (data.version !== APP_VERSION) return socket.emit('version_error', `Версия сервера: ${APP_VERSION}`);
        
        // --- ПРОВЕРКА IP ---
        if (database[data.name]) {
            if (database[data.name].ip !== ip) {
                console.log(`[REJECT] ${data.name} (IP mismatch: ${ip} vs ${database[data.name].ip})`);
                return socket.emit('version_error', 'Этот ник занят другим игроком!');
            }
        } else {
            database[data.name] = { score: 0, ip: ip };
        }

        players[socket.id] = {
            id: socket.id, name: data.name, x: 0, z: 0, hp: 100, isAlive: true,
            weapon: 'pistol', 
            ammo: { pistol: 17, shotgun: 5, rifle: 30, sniper: 5, smg: 40 },
            reloading: {}, lastDir: { x: 0, z: -1 }, color: Math.random() * 0xffffff,
            lastShot: 0, lastHit: 0
        };
        console.log(`[JOIN] ${data.name} с IP ${ip}`);
    });

    socket.on('move', (d) => {
        const p = players[socket.id];
        if (p?.isAlive) {
            if (canMove(d.x, p.z)) p.x = d.x;
            if (canMove(p.x, d.z)) p.z = d.z;
            p.lastDir = d.lastDir;
            
            // Подбор лута
            loot = loot.filter(l => {
                if (Math.hypot(p.x - l.x, p.z - l.z) < 1.5) {
                    p.ammo[p.weapon] = WEAPONS[p.weapon].clip;
                    p.reloading[p.weapon] = false;
                    return false;
                }
                return true;
            });
        }
    });

    socket.on('dash', (d) => {
        const p = players[socket.id];
        if (p?.isAlive && canMove(d.x, d.z)) { p.x = d.x; p.z = d.z; }
    });

    socket.on('shoot', (type) => {
        const p = players[socket.id];
        const w = WEAPONS[type];
        
        // Проверка: жив, патроны, не перезаряжается
        if (!p || !p.isAlive || p.reloading[type] || p.ammo[type] <= 0) return;
        
        // Проверка: Кулдаун стрельбы (анти-кликер)
        if (Date.now() - p.lastShot < w.cd) return;

        p.weapon = type;
        p.lastShot = Date.now();
        p.ammo[type]--;
        p.lastHit = Date.now(); // Сбиваем реген

        const fire = (ang) => {
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dx = (p.lastDir.x * cos - p.lastDir.z * sin) * 0.7;
            const dz = (p.lastDir.x * sin + p.lastDir.z * cos) * 0.7;
            bullets.push({ owner: socket.id, x: p.x, z: p.z, dx, dz, t: Date.now(), dmg: w.dmg });
        };

        if (type === 'shotgun') { for(let i=-2; i<=2; i++) fire(i*0.15); }
        else fire(0);

        if (p.ammo[type] <= 0) {
            p.reloading[type] = true;
            setTimeout(() => { if(players[socket.id]) { p.ammo[type] = w.clip; p.reloading[type] = false; }}, w.reload);
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

setInterval(() => {
    bullets = bullets.filter(b => {
        b.x += b.dx; b.z += b.dz;
        let hit = false;
        MAP_OBSTACLES.forEach(o => { if (b.x > o.x-o.w/2 && b.x < o.x+o.w/2 && b.z > o.z-o.d/2 && b.z < o.z+o.d/2) hit = true; });
        
        for (let id in players) {
            let p = players[id];
            if (p.isAlive && id !== b.owner && Math.hypot(b.x - p.x, b.z - p.z) < 0.75) {
                p.hp -= b.dmg; p.lastHit = Date.now(); hit = true;
                if (p.hp <= 0) {
                    p.isAlive = false;
                    if (database[players[b.owner]?.name]) database[players[b.owner].name].score++;
                    io.emit('log', `💀 ${players[b.owner]?.name} -> ${p.name}`);
                    setTimeout(() => { if (players[id]) { p.hp = 100; p.isAlive = true; p.x=0; p.z=0; }}, 5000);
                }
            }
        }
        return !hit && Date.now() - b.t < 1500;
    });

    // Регенерация
    Object.values(players).forEach(p => {
        if(p.isAlive && p.hp < 100 && Date.now() - p.lastHit > 5000) p.hp += 0.2;
    });

    const lb = {};
    Object.values(players).forEach(p => lb[p.name] = database[p.name]?.score || 0);
    io.emit('state', { players, bullets, loot, obstacles: MAP_OBSTACLES, leaderboard: lb });
}, 1000 / 60);

server.listen(PORT, '0.0.0.0', () => console.log(`Server v${APP_VERSION} Running`));
// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = '1010'; 
const WATCHED_FILES = ['Auction.html'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Auction.html')));

// --- Persistence ---
const PERSIST_FILE = path.join(__dirname, 'auction_data.json');

function loadData() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
      if (!data.teams) data.teams = [];
      if (!data.categories) data.categories = [];
      if (!data.playersSnapshot) data.playersSnapshot = {};
      if (!data.activeBids) data.activeBids = {};
      if (!data.soldPrices) data.soldPrices = {};
      return data;
    }
  } catch (e) { console.warn('Load Error', e.message); }
  return null;
}

function saveData(data) {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2), 'utf8'); } 
  catch (e) { console.warn('Save Error', e.message); }
}

// Default state
let state = loadData() || {
  teams: [
    { id: 't1', name: 'Royal Challengers', purse: 500, password: '123', purchases: {} },
    { id: 't2', name: 'Chennai Kings', purse: 500, password: '123', purchases: {} },
    { id: 't3', name: 'Mumbai Indians', purse: 500, password: '123', purchases: {} }
  ],
  categories: [], 
  playersSnapshot: {}, 
  activeBids: {}, // { "CatID:PlayerName": 120 }
  soldPrices: {}, // { "CatID:PlayerName": 500 }
  passRecords: {}
};

let SOLD_PLAYERS = new Set();
// Rebuild sold set
if(state.teams) {
  state.teams.forEach(t => {
    if(t.purchases) Object.values(t.purchases).forEach(name => { if(name) SOLD_PLAYERS.add(name); });
  });
}

io.on('connection', (socket) => {
  const publicTeams = state.teams.map(t => ({ id: t.id, name: t.name })); 
  socket.emit('init:auth', { teams: publicTeams });

  // Auth
  socket.on('auth:login', (payload) => {
    const { type, password, teamId } = payload;
    if (type === 'admin') {
      if (password === ADMIN_PASS) {
        socket.handshake.auth.token = ADMIN_PASS;
        socket.emit('auth:success', { role: 'admin', state });
      } else socket.emit('auth:fail', 'Invalid Admin Password');
    } else if (type === 'team') {
      const team = state.teams.find(t => t.id === teamId);
      if (team && team.password === password) {
        socket.emit('auth:success', { role: 'team', teamId: team.id, state });
      } else socket.emit('auth:fail', 'Invalid Team Password');
    } else {
      socket.emit('auth:success', { role: 'listener', state });
    }
  });

  // Admin: Update Config
  socket.on('admin:updateConfig', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    
    if (payload.categories) state.categories = payload.categories;
    if (payload.teams) {
      state.teams = payload.teams.map(newT => {
        const existing = state.teams.find(t => t.id === newT.id);
        return {
          ...newT,
          purse: Number(newT.purse),
          purchases: existing ? existing.purchases : (newT.purchases || {})
        };
      });
    }
    saveData(state);
    io.emit('state:updated', state); 
  });

  // Admin: Delete Category
  socket.on('admin:deleteCategory', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    state.categories = state.categories.filter(c => c.id !== payload.id);
    if(state.playersSnapshot[payload.id]) delete state.playersSnapshot[payload.id];
    
    const prefix = payload.id + ':';
    Object.keys(state.activeBids).forEach(key => { if(key.startsWith(prefix)) delete state.activeBids[key]; });
    Object.keys(state.soldPrices).forEach(key => { if(key.startsWith(prefix)) delete state.soldPrices[key]; });
    
    saveData(state);
    io.emit('state:updated', state);
  });

  // --- RESET LOGIC ---

  // 1. Reset Individual Player (NEW)
  socket.on('admin:resetPlayer', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    const { category, name } = payload;
    const key = `${category}:${name}`;

    // Refund team if sold
    state.teams.forEach(t => {
      if(t.purchases && t.purchases[category] === name) {
        const pricePaid = Number(state.soldPrices[key]) || 0;
        t.purse = Number(t.purse) + pricePaid;
        delete t.purchases[category];
      }
    });

    // Clear global sold status and price records
    SOLD_PLAYERS.delete(name);
    if(state.activeBids[key]) delete state.activeBids[key];
    if(state.soldPrices[key]) delete state.soldPrices[key];

    saveData(state);
    io.emit('state:updated', state);
    io.emit('admin:toast', { type: 'success', msg: `Player ${name} reset.` });
  });

  // 2. Reset Category
  socket.on('admin:resetCategory', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    const catId = payload.id;
    
    // Refund Teams
    state.teams.forEach(t => {
      if(t.purchases && t.purchases[catId]) {
        const pName = t.purchases[catId];
        const key = `${catId}:${pName}`;
        const pricePaid = Number(state.soldPrices[key]) || 0;
        t.purse = Number(t.purse) + pricePaid;
        delete t.purchases[catId];
        SOLD_PLAYERS.delete(pName);
      }
    });

    // Wipe Prices
    const prefix = catId + ':';
    Object.keys(state.activeBids).forEach(key => { if(key.startsWith(prefix)) delete state.activeBids[key]; });
    Object.keys(state.soldPrices).forEach(key => { if(key.startsWith(prefix)) delete state.soldPrices[key]; });

    saveData(state);
    io.emit('state:updated', state);
    io.emit('admin:toast', { type: 'success', msg: `Category ${catId} reset.` });
  });

  // 3. Reset Team
  socket.on('admin:resetTeam', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    const team = state.teams.find(t => t.id === payload.id);
    if(!team) return;

    if(team.purchases) {
      Object.entries(team.purchases).forEach(([catId, pName]) => {
        if(pName) {
          SOLD_PLAYERS.delete(pName);
          const key = `${catId}:${pName}`;
          if(state.soldPrices[key]) delete state.soldPrices[key];
        }
      });
    }

    team.purchases = {};
    team.purse = 500; 

    saveData(state);
    io.emit('state:updated', state);
    io.emit('admin:toast', { type: 'success', msg: `Team ${team.name} reset.` });
  });

  // 4. Reset All
  socket.on('admin:resetAll', () => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    state = {
      teams: [], categories: [], playersSnapshot: {},
      activeBids: {}, soldPrices: {}, passRecords: {}
    };
    SOLD_PLAYERS.clear();
    saveData(state);
    io.emit('state:updated', state);
    io.emit('admin:toast', { type: 'error', msg: 'System FULL RESET.' });
  });

  // --- AUCTION ---
  socket.on('bid:request', (payload) => io.emit('admin:toast', { type: 'info', msg: `Bid Request: ${payload.teamName} for ${payload.playerName}` }));

  socket.on('player:bid', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    const key = `${payload.category}:${payload.name}`;
    state.activeBids[key] = payload.price;
    saveData(state);
    io.emit('player:bid', payload);
  });

  socket.on('player:sold', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    const { category, name, price, teamId } = payload;

    if (SOLD_PLAYERS.has(name)) return socket.emit('action:rejected', 'Player already sold!');

    const team = state.teams.find(t => t.id === teamId);
    if (!team) return socket.emit('action:rejected', 'Team not found');
    
    if (team.purchases && team.purchases[category]) {
      return socket.emit('action:rejected', `Team ${team.name} already has a player in ${category}!`);
    }

    const numericPrice = Number(price);
    if (team.purse < numericPrice) return socket.emit('action:rejected', 'Insufficient funds');

    team.purse = Number(team.purse) - numericPrice;
    team.purchases[category] = name;
    SOLD_PLAYERS.add(name);

    const key = `${category}:${name}`;
    state.soldPrices[key] = numericPrice;
    if(state.activeBids[key]) delete state.activeBids[key];

    saveData(state);
    io.emit('player:sold', { payload, teams: state.teams });
  });

  // --- DATA SYNC ---
  socket.on('players:save', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    state.playersSnapshot[payload.category] = payload.players;
    saveData(state);
    io.emit('players:load', payload); 
  });
  socket.on('players:load', (payload) => io.emit('players:load', payload));
  socket.on('players:clear', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    delete state.playersSnapshot[payload.category];
    saveData(state);
    io.emit('players:clear', payload);
  });
  socket.on('textarea:update', (payload) => {
    if (socket.handshake.auth.token !== ADMIN_PASS) return;
    socket.broadcast.emit('textarea:update', payload);
  });
});

WATCHED_FILES.forEach(fname => {
  const full = path.join(__dirname, fname);
  if (fs.existsSync(full)) fs.watch(full, () => io.emit('server:reload', { ts: Date.now() }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
function hashPassword(value) { const salt=crypto.randomBytes(16).toString('hex'); return 'scrypt$'+salt+'$'+crypto.scryptSync(value,salt,64).toString('hex'); }
function matchesPassword(value, stored) { if(typeof value!=='string'||typeof stored!=='string')return false; if(!stored.startsWith('scrypt$'))return value===stored; const [,salt,hash]=stored.split('$'); const actual=crypto.scryptSync(value,salt,64);const expected=Buffer.from(hash,'hex');return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected); }

const app = express();
const server = http.createServer(app);

// Flexible CORS: allow requests from any frontend domain, strip trailing slashes, and handle preflight
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        res.header("Access-Control-Allow-Origin", origin);
    } else {
        res.header("Access-Control-Allow-Origin", "*");
    }
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Serve static assets and index.html if accessed directly
app.get(['/', '/index.html'], (req, res) => {
    if (req.path === '/' && process.env.RENDER === 'true') return res.sendFile(path.join(__dirname, 'status.html'));
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    res.type('html').send(html.replace('<!-- auction-server-config -->',
        '<script>window.AUCTION_BACKEND_URL = location.origin;</script>'));
});
// Serve only explicit public assets; local tournament storage stays private.
app.get('/hammer.wav',(req,res)=>res.sendFile(path.join(__dirname,'..','hammer.wav')));
app.get('/hammer.png',(req,res)=>res.sendFile(path.join(__dirname,'..','hammer.png')));

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            // Allow all origins (reflection) so deployed frontend can connect from anywhere
            callback(null, true);
        },
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;

// =========================================================
// MULTI-HOST / MULTI-TENANT ISOLATION STORAGE
// =========================================================
let MANAGERS = { 'admin': 'admin' };
let LEAGUES = {};
const DELETING_ROOMS = new Set();

function findManagerKey(hostId) {
    if (!hostId) return null;
    const target = hostId.toString().trim().toLowerCase();
    if (target === 'admin') {
        const adminKey = Object.keys(MANAGERS).find(k => k.toLowerCase() === 'admin');
        return adminKey || 'admin';
    }
    const match = Object.keys(MANAGERS).find(k => k.toLowerCase() === target);
    return match || null;
}

function createCleanLeague() {
    return {
        teams: [],
        categories: [
            { id: 'CAT_BAT', name: 'Batsmen', base: 50, increment: 10 },
            { id: 'CAT_BOWL', name: 'Fast Bowlers', base: 50, increment: 10 },
            { id: 'CAT_ALL', name: 'All-Rounders', base: 70, increment: 10 },
            { id: 'CAT_WK', name: 'Wicket Keepers', base: 40, increment: 10 }
        ],
        playersSnapshot: {
            CAT_BAT: [
                { name: 'Virat Kohli', image: '' },
                { name: 'Rohit Sharma', image: '' }
            ],
            CAT_BOWL: [
                { name: 'Jasprit Bumrah', image: '' },
                { name: 'Mitchell Starc', image: '' }
            ],
            CAT_ALL: [
                { name: 'Hardik Pandya', image: '' },
                { name: 'Ravindra Jadeja', image: '' }
            ],
            CAT_WK: [
                { name: 'MS Dhoni', image: '' },
                { name: 'Rishabh Pant', image: '' }
            ]
        },
        activeBids: {},
        activeBidders: {},
        previousOwners: {},
        soldPrices: {},
        directSigns: {},
        rtmEvents: {},
        rtmImpactLocks: {},
        schedule: { teamNumbers: {}, matches: [] },
        lotteryQueue: [],
        unsoldPlayers: {},
        biddingActive: false,
        codeShuffleActive: false,
        currentActivePlayer: null,
        pickedPlayerCode: null,
        config: { impactAmount: 0 },
        rtmState: null
    };
}

function getLeague(hostId) {
    const raw = (hostId || 'admin').toString().trim();
    const target = raw.toLowerCase();
    const existingKey = Object.keys(LEAGUES).find(k => k.toLowerCase() === target);
    const key = existingKey || raw;
    if (!LEAGUES[key]) {
        if (key.toLowerCase() === 'admin') {
            LEAGUES[key] = (typeof STATE !== 'undefined' && STATE) ? STATE : createCleanLeague();
        } else {
            LEAGUES[key] = createCleanLeague();
        }
    }
    return LEAGUES[key];
}

function broadcastLeagueUpdate(hostId, league) {
    const rawHost = hostId || 'admin';
    const canonicalKey = rawHost.toString().trim().toLowerCase();
    const publicStatePayload = publicState(league, false);
    const adminStatePayload = publicState(league, true);
    const safeTeams = (league.teams || []).map(({ password, ...t }) => t);

    // 1. Emit safe state to public participants in this host
    io.to(`host:${canonicalKey}`).emit('state:updated', publicStatePayload);


    // 2. Emit full state (passwords preserved) to admin room
    io.to(`admin:${canonicalKey}`).emit('state:updated', adminStatePayload);

    // 3. If default admin host, also emit globally
    if (canonicalKey === 'admin') {
        io.to('host:admin').emit('state:updated', publicStatePayload);
    }
}


app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true, status: 'Server is running', service: 'Auction Socket Backend', uptime: Math.floor(process.uptime()), storageMode: db ? 'firestore' : 'local-file', timestamp: Date.now() });
});

app.get('/api/verify-host/:hostId', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const rawHost = (req.params.hostId || '').trim();
    if (!rawHost) {
        return res.status(400).json({ ok: false, notFound: true, error: 'Host ID required' });
    }
    const foundManager = findManagerKey(rawHost);
    const isRegistered = !!foundManager || rawHost.toLowerCase() === 'admin';
    if (!isRegistered) {
        return res.status(404).json({ ok: false, notFound: true, hostId: rawHost });
    }
    const canonicalHost = foundManager || rawHost;
    const hostLeague = getLeague(canonicalHost);
    const safeTeams = (hostLeague.teams || []).map(({ password, ...t }) => t);
    return res.status(200).json({
        ok: true,
        notFound: false,
        hostId: canonicalHost,
        teams: safeTeams
    });
});

app.get(['/status', '/status.html'], (req, res) => res.sendFile(path.join(__dirname, 'status.html')));

let db = null;
let DOC_REF = null;

try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(sa);
    } catch (_) {
      if (fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT)) {
        credential = admin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT));
      }
    }
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
  }

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || (process.env.FIREBASE_PROJECT_ID ? `${process.env.FIREBASE_PROJECT_ID}.appspot.com` : undefined);

  if (credential) {
    admin.initializeApp({
      credential,
      storageBucket: storageBucket || undefined
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      admin.initializeApp({
        storageBucket: storageBucket || undefined
      });
    } catch (_) {}
  }
} catch (error) {
  console.error("Firebase initialization error:", error.message);
}

let bucket = null;
if (admin.apps.length > 0) {
  db = admin.firestore();
  DOC_REF = db.collection('auction_data').doc('current_state');
  try {
    bucket = admin.storage().bucket();
    console.log("✅ Firebase Storage connected successfully.");
  } catch (e) {
    console.warn("⚠️ Firebase Storage bucket initialization note:", e.message);
  }
} else {
  console.warn("⚠️ Firebase credentials missing or invalid. Using local file storage.");
  DOC_REF = null;
}

// Dedicated Helper: Permanently purge player image assets from Firebase Storage
async function deletePlayersFromFirebaseStorage(playerList = []) {
    if (!admin.apps || admin.apps.length === 0) return;
    try {
        let storageBucket = bucket;
        if (!storageBucket) {
            try { storageBucket = admin.storage().bucket(); } catch (_) {}
        }
        if (!storageBucket) return;

        const filePathsToDelete = new Set();

        (playerList || []).forEach(p => {
            if (p && p.image && typeof p.image === 'string') {
                const img = p.image.trim();
                if (img.includes('firebasestorage.googleapis.com')) {
                    try {
                        const urlObj = new URL(img);
                        const match = urlObj.pathname.match(/\/o\/(.+)$/);
                        if (match && match[1]) {
                            filePathsToDelete.add(decodeURIComponent(match[1]));
                        }
                    } catch (_) {}
                } else if (img.startsWith('gs://')) {
                    const parts = img.replace('gs://', '').split('/');
                    parts.shift(); // remove bucket name
                    filePathsToDelete.add(parts.join('/'));
                } else if (img.startsWith('/players/') || img.startsWith('players/')) {
                    filePathsToDelete.add(img.replace(/^\/+/, ''));
                }
            }
        });

        // Delete individually identified player image files
        for (const filePath of filePathsToDelete) {
            try {
                const file = storageBucket.file(filePath);
                const [exists] = await file.exists();
                if (exists) {
                    await file.delete();
                    console.log(`[Firebase Storage] Deleted player asset: ${filePath}`);
                }
            } catch (err) {
                console.warn(`[Firebase Storage] Note deleting ${filePath}:`, err.message);
            }
        }

        // Also sweep any files under 'players/' prefix in Firebase Storage bucket
        try {
            const [files] = await storageBucket.getFiles({ prefix: 'players/' });
            if (files && files.length > 0) {
                for (const file of files) {
                    try {
                        await file.delete();
                        console.log(`[Firebase Storage] Swept player file: ${file.name}`);
                    } catch (_) {}
                }
            }
        } catch (err) {
            // Non-fatal if bucket does not have players/ prefix or list fails
        }
    } catch (e) {
        console.warn("[Firebase Storage] Global purge note:", e.message);
    }
}


let TIMERS = {}; // hostId -> { paused, time, interval }
function getHostTimer(hostId) {
    const raw = (hostId || 'admin').toString().trim();
    const target = raw.toLowerCase();
    const existingKey = Object.keys(TIMERS).find(k => k.toLowerCase() === target);
    const key = existingKey || raw;
    if (!TIMERS[key]) {
        TIMERS[key] = { paused: false, time: 30, interval: null };
    }
    return TIMERS[key];
}

let STATE = { 
    teams: [], categories: [], playersSnapshot: {}, activeBids: {}, activeBidders: {}, previousOwners: {}, soldPrices: {}, directSigns: {}, rtmEvents: {}, rtmImpactLocks: {}, managers: {}, currentActivePlayer: null, config: { impactAmount: 0 }, rtmState: null,
    lotteryQueue: [], unsoldPlayers: {}, biddingActive: false, codeShuffleActive: false,
    schedule: { teamNumbers: {}, matches: [] }
};
LEAGUES['admin'] = STATE;

function publicState(state, forAdmin = false) {
    if (!state) return state;
    const { managers, room, ...safe } = state;
    if(room) { const {viewerPassword, ...info}=room; safe.room=info; }
    if (!forAdmin && safe.teams && Array.isArray(safe.teams)) {
        safe.teams = safe.teams.map(t => {
            if (!t) return t;
            const { password, ...safeTeam } = t;
            return safeTeam;
        });
    }
    return safe;
}

let TIMER_STATE = { paused: false, time: 30 };
TIMERS['admin'] = TIMER_STATE;
let serverTimerInterval = null;
const PLAYER_REVEAL_DELAY_MS = 350;

function markPlayerUnsoldInternal(category, name, hostId) {
    const rawHost = hostId || 'admin';
    const hostKey = rawHost.toString().toLowerCase();
    const league = getLeague(rawHost);
    const key = `${category}:${name}`;
    if (!league.unsoldPlayers) league.unsoldPlayers = {};
    league.unsoldPlayers[key] = true;
    
    // Filter unsold player from lotteryQueue during regular round so they wait for the Unsold Round
    if (league.lotteryQueue) {
        league.lotteryQueue = league.lotteryQueue.filter(p => !(p.category === category && p.name === name));
        if (league.unsoldRoundActive) {
            const cat = (league.categories || []).find(c => c.id === category);
            const pObj = ((league.playersSnapshot && league.playersSnapshot[category]) || []).find(p => p.name === name);
            if (cat && pObj) {
                const usedCodes = new Set(league.lotteryQueue.map(p => p.code).filter(Boolean));
                league.lotteryQueue.push({ category: cat.id, name: pObj.name, base: cat.base, image: pObj.image, code: makePlayerCode(cat.id, pObj.name, usedCodes), isUnsold: true });
            }
        }
    }

    league.currentActivePlayer = null;
    league.pickedPlayerCode = null;
    league.biddingActive = false;

    const timer = getHostTimer(rawHost);
    timer.paused = false;
    timer.time = 30;
    if (timer.interval) {
        clearInterval(timer.interval);
        timer.interval = null;
    }

    if (hostKey === 'admin') {
        STATE.unsoldPlayers = league.unsoldPlayers;
        STATE.lotteryQueue = league.lotteryQueue;
        STATE.currentActivePlayer = null;
        STATE.pickedPlayerCode = null;
        STATE.biddingActive = false;
        TIMER_STATE = { paused: false, time: 30 };
        if (serverTimerInterval) {
            clearInterval(serverTimerInterval);
            serverTimerInterval = null;
        }
        io.to('host:admin').emit('popup:close');
        io.to('host:admin').emit('player:unsold', { category, name });
        io.to('host:admin').emit('state:updated', publicState(STATE));
    }

    io.to(`host:${hostKey}`).emit('popup:close');
    io.to(`host:${hostKey}`).emit('player:unsold', { category, name });
    io.to(`host:${hostKey}`).emit('state:updated', publicState(league));
    immediateSaveToFirebase();
}

function startHostTimer(hostId, initialSeconds) {
    const rawHost = (hostId || 'admin').toString().trim();
    const hostKey = rawHost.toLowerCase();
    const league = getLeague(rawHost);
    if (!league.currentActivePlayer) return;
    const timer = getHostTimer(rawHost);

    league.biddingActive = true;
    if (hostKey === 'admin') STATE.biddingActive = true;

    timer.paused = false;
    if (initialSeconds !== undefined && !isNaN(Number(initialSeconds))) {
        timer.time = Number(initialSeconds);
    } else if (timer.time <= 0) {
        timer.time = 30;
    }

    if (timer.interval) {
        clearInterval(timer.interval);
        timer.interval = null;
    }

    timer.interval = setInterval(() => {
        if (timer.paused) return;
        timer.time--;
        const syncPayload = { paused: timer.paused, time: timer.time };
        io.to(`host:${hostKey}`).emit('timer:sync', syncPayload);
        if (hostKey === 'admin') {
            TIMER_STATE = syncPayload;
            io.to('host:admin').emit('timer:sync', syncPayload);
        }

        if (timer.time <= 0) {
            clearInterval(timer.interval);
            timer.interval = null;
            handleTimerExpiration(rawHost);
        }
    }, 1000);

    const syncPayload = { paused: timer.paused, time: timer.time };
    io.to(`host:${hostKey}`).emit('bidding:started');
    io.to(`host:${hostKey}`).emit('timer:sync', syncPayload);
    if (hostKey === 'admin') {
        TIMER_STATE = syncPayload;
        io.to('host:admin').emit('bidding:started');
        io.to('host:admin').emit('timer:sync', syncPayload);
    }
}

function pauseHostTimer(hostId, customTime) {
    const rawHost = (hostId || 'admin').toString().trim();
    const hostKey = rawHost.toLowerCase();
    const timer = getHostTimer(rawHost);
    timer.paused = true;
    if (customTime !== undefined && !isNaN(Number(customTime))) {
        timer.time = Number(customTime);
    }
    if (timer.interval) {
        clearInterval(timer.interval);
        timer.interval = null;
    }
    const syncPayload = { paused: true, time: timer.time };
    io.to(`host:${hostKey}`).emit('timer:sync', syncPayload);
    if (hostKey === 'admin') {
        TIMER_STATE = syncPayload;
        io.to('host:admin').emit('timer:sync', syncPayload);
    }
}

function pauseServerTimer(hostId) {
    pauseHostTimer(hostId || 'admin');
}

function handleTimerExpiration(rawHost) {
    const hostKey = rawHost.toString().toLowerCase();
    const league = getLeague(rawHost);
    const timer = getHostTimer(rawHost);
    timer.paused = true;
    timer.time = 0;
    if (timer.interval) {
        clearInterval(timer.interval);
        timer.interval = null;
    }

    if (league.currentActivePlayer) {
        const p = league.currentActivePlayer;
        const key = `${p.category}:${p.name}`;
        const highBidder = league.activeBidders ? league.activeBidders[key] : null;
        const hasTeamBid = highBidder && highBidder !== 'ADMIN' && (league.teams || []).some(t => t.id === highBidder);
        const isAdminAdjusted = !!p.adminAdjusted || highBidder === 'ADMIN';
        const finalPrice = Number(league.activeBids?.[key]) || Number(p.currentPrice) || Number(p.base) || 0;

        if (hasTeamBid) {
            // High bidder is an enrolled franchise
            const soldSuccess = executeSale({
                category: p.category,
                name: p.name,
                price: finalPrice,
                teamId: highBidder,
                isDirect: false,
                isRTM: false
            }, rawHost);
            if (soldSuccess) {
                const team = (league.teams || []).find(t => t.id === highBidder);
                const toastMsg = `⏱️ Time's up! ${p.name} SOLD to ${team ? team.name : highBidder} @ ৳${finalPrice}!`;
                io.to(`host:${hostKey}`).emit('admin:toast', { msg: toastMsg });
                if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: toastMsg });
            }
        } else if (isAdminAdjusted) {
            // Keep stage open so admin can award to chosen franchise or mark unsold
            const syncPayload = { paused: true, time: 0 };
            io.to(`host:${hostKey}`).emit('timer:sync', syncPayload);
            io.to(`host:${hostKey}`).emit('timer:times_up_admin_choice', {
                category: p.category,
                name: p.name,
                price: finalPrice,
                adminAdjusted: true
            });
            const toastMsg = `⏱️ Time's up! Admin adjusted price to ৳${finalPrice} — choose franchise or mark unsold.`;
            io.to(`host:${hostKey}`).emit('admin:toast', { msg: toastMsg });
            if (hostKey === 'admin') {
                TIMER_STATE = syncPayload;
                io.to('host:admin').emit('timer:sync', syncPayload);
                io.to('host:admin').emit('timer:times_up_admin_choice', { category: p.category, name: p.name, price: finalPrice, adminAdjusted: true });
                io.to('host:admin').emit('admin:toast', { msg: toastMsg });
            }
        } else {
            // No bids and no admin increase -> mark player unsold automatically!
            markPlayerUnsoldInternal(p.category, p.name, rawHost);
            const toastMsg = `⏱️ Time's up! ${p.name} marked UNSOLD (no bids placed)`;
            io.to(`host:${hostKey}`).emit('admin:toast', { msg: toastMsg });
            if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: toastMsg });
        }
    }
}

function codeSeed(category, name) {
    return `${category || ''}:${name || ''}`.toUpperCase();
}

function hashCode(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36).toUpperCase();
}

function makePlayerCode(category, name, usedCodes) {
    const catPart = String(category || 'XX').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(2, 'X').slice(0, 2);
    const seed = codeSeed(category, name);
    let attempt = 0;
    let code = '';
    do {
        const suffix = hashCode(`${seed}:${attempt}`).padStart(3, '0');
        code = `${catPart}${suffix}`.slice(0, 4);
        attempt++;
    } while (usedCodes.has(code) && attempt < 100);
    usedCodes.add(code);
    return code;
}

function buildShufflePool(targetLeague) {
    const league = targetLeague || STATE;
    const usedCodes = new Set();
    const pool = [];
    const unsoldPool = [];
    (league.categories || []).forEach(cat => {
        const players = (league.playersSnapshot && league.playersSnapshot[cat.id]) || [];
        players.forEach(p => {
            const key = `${cat.id}:${p.name}`;
            let isSold = false;
            (league.teams || []).forEach(t => { if (t.purchases && t.purchases[cat.id] === p.name) isSold = true; });
            if (!isSold) {
                const entry = {
                    category: cat.id,
                    name: p.name,
                    base: cat.base,
                    image: p.image,
                    code: makePlayerCode(cat.id, p.name, usedCodes),
                    isUnsold: !!(league.unsoldPlayers && league.unsoldPlayers[key])
                };
                if (entry.isUnsold) unsoldPool.push(entry);
                else pool.push(entry);
            }
        });
    });
    return { pool, unsoldPool };
}

const LOCAL_STATE_FILE = process.env.AUCTION_DATA_FILE || path.join(__dirname,'auction-data.local.json');
function saveLocalState(){const target=LOCAL_STATE_FILE+'.tmp';fs.writeFileSync(target,JSON.stringify({managers:MANAGERS,leagues:LEAGUES,defaultLeague:STATE}),{mode:0o600});fs.renameSync(target,LOCAL_STATE_FILE);}
let firebaseSaveTimeout = null;
function debouncedSaveToFirebase() {
    if (firebaseSaveTimeout) clearTimeout(firebaseSaveTimeout);
    firebaseSaveTimeout = setTimeout(async () => {
        try {
            LEAGUES['admin'] = STATE;
            if(!DOC_REF) {saveLocalState();return;}
            await DOC_REF.set({ managers: MANAGERS, leagues: LEAGUES, defaultLeague: STATE });
        } catch (e) {
            console.error("Firebase Save Error:", e);
        }
    }, 1500); 
}

async function immediateSaveToFirebase({ throwOnError = false } = {}) {
    try {
        LEAGUES['admin'] = STATE;
        if(!DOC_REF) {saveLocalState();return;}
        await DOC_REF.set({ managers: MANAGERS, leagues: LEAGUES, defaultLeague: STATE });
    } catch (e) { if (throwOnError) throw e; }
}

async function loadFromFirebase() {
    if(!DOC_REF){if(fs.existsSync(LOCAL_STATE_FILE)){const data=JSON.parse(fs.readFileSync(LOCAL_STATE_FILE,'utf8'));MANAGERS=data.managers;LEAGUES=data.leagues;STATE=data.defaultLeague;}return;} 
    try { 
        const doc = await Promise.race([
            DOC_REF.get(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Firebase load timed out")), 2000))
        ]); 
        if (doc.exists) { 
            const data = doc.data();
            if (data.managers) MANAGERS = { ...MANAGERS, ...data.managers };
            if (data.leagues) {
                LEAGUES = data.leagues;
                const adminKey = Object.keys(LEAGUES).find(k => k.toLowerCase() === 'admin');
                if (adminKey && LEAGUES[adminKey]) STATE = LEAGUES[adminKey];
                else if (LEAGUES['admin']) STATE = LEAGUES['admin'];
            } else if (data.teams) {
                // Backward compatible legacy migration
                STATE = data;
                LEAGUES['admin'] = STATE;
            }
            if (!STATE.config) STATE.config = { impactAmount: 0 }; 
            if (!STATE.teams) STATE.teams = [];
            if (!STATE.categories) STATE.categories = [];
        } else { await immediateSaveToFirebase(); } 
    } catch (e) { console.log("Firebase Load Error:", e); } 
}

function getSaleReserve(team, activeCategory, league) {
    const cats = (league && Array.isArray(league.categories)) ? league.categories : (STATE.categories || []);
    return cats.reduce((total, cat) => {
        if (cat.id !== activeCategory && (!team.purchases || !team.purchases[cat.id])) {
            return total + (Number(cat.base) || 0);
        }
        return total;
    }, 0);
}

function isRTMImpactLocked(teamId, category, name, STATE = getLeague('admin')) {
    const key = `${category}:${name}`;
    return !!STATE.rtmImpactLocks && !!STATE.rtmImpactLocks[key] && !!STATE.rtmImpactLocks[key][teamId];
}

function validateRTMOffer({ category, name, rtmTeamId, rtmPrice }, STATE = getLeague('admin')) {
    const key = `${category}:${name}`;
    const team = STATE.teams.find(t => t.id === rtmTeamId);
    const cat = STATE.categories.find(c => c.id === category);
    if (!team) return { ok: false, msg: '❌ RTM Failed: team not found' };
    if (!cat) return { ok: false, msg: '❌ RTM Failed: category not found' };
    if (STATE.rtmState) return { ok: false, msg: '❌ RTM Failed: another RTM is already in progress' };
    if (team.rtmUsed) return { ok: false, msg: `❌ RTM Failed: ${team.name} already used RTM!` };
    if (!STATE.previousOwners || STATE.previousOwners[key] !== rtmTeamId) {
        return { ok: false, msg: `❌ RTM Failed: ${team.name} is not tagged to this player` };
    }
    if (team.purchases && team.purchases[category]) {
        return { ok: false, msg: `❌ RTM Failed: ${team.name} already has a player from ${category}!` };
    }

    const inc = Number(cat.increment) || 0;
    if (inc <= 0) return { ok: false, msg: '❌ RTM Failed: category increment must be greater than 0' };

    const currentBid = Number(STATE.activeBids && STATE.activeBids[key]) || Number(cat.base) || 0;
    const price = Number(rtmPrice) || (currentBid + inc);
    const diff = price - currentBid;
    const isValidStep = diff > 0 && Math.abs((diff / inc) - Math.round(diff / inc)) < 0.000001;
    if (!isValidStep) {
        return { ok: false, msg: `❌ RTM Failed: amount must be greater than ৳${currentBid} in ৳${inc} steps` };
    }

    const reserve = getSaleReserve(team, category, STATE);
    const maxOffer = Math.max(0, (Number(team.purse) || 0) - reserve);
    if (price > maxOffer || Number(team.purse) < price) {
        return { ok: false, msg: `❌ RTM Failed: ${team.name} can enforce up to ৳${maxOffer}` };
    }

    return { ok: true, team, price, currentBid, inc, maxOffer };
}

function executeSale(data, hostId) {
    const rawHost = hostId || 'admin';
    const hostKey = rawHost.toString().toLowerCase();
    const league = getLeague(rawHost);
    const team = (league.teams || []).find(t => t.id === data.teamId);
    const validPrice = Number(data.price) || 0;

    if (team) {
        if (team.purchases && team.purchases[data.category]) {
            const err = `❌ Sale Failed: ${team.name} already has a player from ${data.category}!`;
            io.to(`host:${hostKey}`).emit('admin:toast', { msg: err });
            if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: err });
            return false;
        }

        const requiredReserve = getSaleReserve(team, data.category, league);

        if ((Number(team.purse) - validPrice) < requiredReserve) {
            const err = `❌ Sale Failed: ${team.name} lacks reserve purse!`;
            io.to(`host:${hostKey}`).emit('admin:toast', { msg: err });
            if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: err });
            return false;
        }
        if (Number(team.purse) < validPrice) {
            const err = `❌ Sale Failed: ${team.name} has insufficient funds!`;
            io.to(`host:${hostKey}`).emit('admin:toast', { msg: err });
            if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: err });
            return false;
        }
        
        if (data.isDirect && !data.isRTM && !data.isAdminAward) {
            if (team.directSignUsed) {
                const err = `❌ Sale Failed: ${team.name} already used Direct Sign!`;
                io.to(`host:${hostKey}`).emit('admin:toast', { msg: err });
                if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: err });
                return false;
            }
            team.directSignUsed = true;
            if (!league.directSigns) league.directSigns = {};
            league.directSigns[`${data.category}:${data.name}`] = true;
        }

        if (data.isRTM) {
            team.rtmUsed = true; 
            if (!league.rtmEvents) league.rtmEvents = {};
            league.rtmEvents[`${data.category}:${data.name}`] = true;
        }

        team.purse = Number(team.purse) - validPrice;
        team.purchases = team.purchases || {};
        team.purchases[data.category] = data.name;
        if (!league.soldPrices) league.soldPrices = {};
        league.soldPrices[`${data.category}:${data.name}`] = validPrice;
        
        const bonus = Number((league.config && league.config.impactAmount) || 0);
        const soldKey = `${data.category}:${data.name}`;
        
        (league.teams || []).forEach(t => {
            if (t.impactActive && t.impactTarget === soldKey) {
                if(t.id === data.teamId) { t.impactActive = false; } 
                else { t.purse = Math.max(0, Number(t.purse) - bonus); t.impactActive = false; }
            }
        });
        
        league.currentActivePlayer = null;
        league.pickedPlayerCode = null;
        league.biddingActive = false;

        const timer = getHostTimer(rawHost);
        timer.paused = false;
        timer.time = 30;
        if (timer.interval) {
            clearInterval(timer.interval);
            timer.interval = null;
        }

        if (league.lotteryQueue && Array.isArray(league.lotteryQueue)) {
            league.lotteryQueue = league.lotteryQueue.filter(p => !(p.category === data.category && p.name === data.name));
        }

        if (hostKey === 'admin') {
            STATE.teams = league.teams;
            STATE.directSigns = league.directSigns;
            STATE.rtmEvents = league.rtmEvents;
            STATE.soldPrices = league.soldPrices;
            STATE.currentActivePlayer = null;
            STATE.pickedPlayerCode = null;
            STATE.biddingActive = false;
            STATE.lotteryQueue = league.lotteryQueue;
            TIMER_STATE = { paused: false, time: 30 };
            if (serverTimerInterval) {
                clearInterval(serverTimerInterval);
                serverTimerInterval = null;
            }
        }

        io.to(`host:${hostKey}`).emit('popup:close');
        io.to(`host:${hostKey}`).emit('player:sold', { payload: { ...data, price: validPrice }, teams: publicState(league).teams });
        broadcastLeagueUpdate(rawHost, league);

        if (hostKey === 'admin') {
            io.to('host:admin').emit('popup:close');
            io.to('host:admin').emit('player:sold', { payload: { ...data, price: validPrice }, teams: publicState(STATE).teams });
            io.to('host:admin').emit('state:updated', publicState(STATE));
        }

        immediateSaveToFirebase();
        return true;
    }
    return false;
}

io.on('connection', (socket) => {
    socket.on('status:ping', acknowledge => {
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
    });
    socket.data.hostId = 'admin';
    // Join live channels only after authentication.
    // State is delivered only after room authentication.
    socket.use(([event],next) => {
        if(DELETING_ROOMS.has(socket.data.hostId) && !['status:ping','rooms:list'].includes(event))return;
        if(['team:activateImpact','rtm:lockImpact','rtm:invoke','rtm:respond'].includes(event)&&!['team','admin'].includes(socket.data.role))return socket.emit('auth:team_error','Authenticated team access required');
        if(event.startsWith('admin:') && socket.data.role!=='admin')return socket.emit('auth:team_error','Admin access required');
        if(['players:save','players:clear','schedule:save','schedule:reset'].includes(event) && socket.data.role!=='admin')return socket.emit('auth:team_error','Team or admin access required');
        next();
    });
    function roomList(){return Object.entries(LEAGUES).filter(([,league])=>league.room).map(([id,league])=>({id,name:league.room.name,teams:league.teams.length,live:!!league.biddingActive}));}
    socket.on('rooms:list',()=>socket.emit('rooms:list',roomList()));
    socket.on('room:create',async ({name,password,viewerPassword}={})=>{
        if(typeof name!=='string'||name.trim().length<3||name.trim().length>80)return socket.emit('auth:portal_error','Tournament name must be 3?80 characters');
        if([password,viewerPassword].some(p=>typeof p!=='string'||p.length<8||p.length>128))return socket.emit('auth:portal_error','Both passwords must be 8?128 characters');
        const id='ROOM-'+crypto.randomBytes(4).toString('hex').toUpperCase();
        MANAGERS[id]=hashPassword(password);const league=createCleanLeague();league.playersSnapshot={};
        league.room={name:name.trim(),viewerPassword:hashPassword(viewerPassword),createdAt:Date.now()};LEAGUES[id]=league;
        for(const room of socket.rooms)if(room!==socket.id)socket.leave(room);
        socket.data={role:'admin',hostId:id,teamId:null};socket.join(`host:${id.toLowerCase()}`);socket.join(`admin:${id.toLowerCase()}`);
        await immediateSaveToFirebase();socket.emit('manager:logged_in',{username:id,state:publicState(league,true)});io.emit('rooms:list',roomList());
    });
    socket.on('room:delete', async (data = {}, acknowledge) => {
        if (typeof acknowledge !== 'function') return;
        const hostId = socket.data.hostId;
        const league = LEAGUES[hostId];
        if (socket.data.role !== 'admin' || !league?.room) return acknowledge({ok:false,error:'Only this tournament admin can delete it.'});
        if (typeof data.password !== 'string' || data.password.length > 128 || !matchesPassword(data.password, MANAGERS[hostId])) return acknowledge({ok:false,error:'Incorrect admin password.'});
        if (data.name !== league.room.name) return acknowledge({ok:false,error:'The tournament name does not match.'});
        DELETING_ROOMS.add(hostId);
        const wasBidding = league.biddingActive;
        const timer = getHostTimer(hostId); const remaining = timer.time; const wasPaused = timer.paused;
        pauseHostTimer(hostId);
        const credential = MANAGERS[hostId];
        delete LEAGUES[hostId]; delete MANAGERS[hostId];
        try {
            await immediateSaveToFirebase({throwOnError:true});
        } catch (error) {
            LEAGUES[hostId] = league; MANAGERS[hostId] = credential; DELETING_ROOMS.delete(hostId);
            if (wasBidding && !wasPaused) startHostTimer(hostId, remaining);
            return acknowledge({ok:false,error:'Could not save the deletion. The tournament has been kept. Please try again.'});
        }
        for (const client of io.sockets.sockets.values()) {
            if (client.data.hostId !== hostId) continue;
            client.emit('room:deleted', {hostId,name:league.room.name});
            client.leave(`host:${hostId.toLowerCase()}`); client.leave(`admin:${hostId.toLowerCase()}`);
            client.data = {};
        }
        for (const key of Object.keys(TIMERS)) if (key.toLowerCase() === hostId.toLowerCase()) delete TIMERS[key];
        DELETING_ROOMS.delete(hostId);
        acknowledge({ok:true}); io.emit('rooms:list',roomList());
    });
    socket.on('room:viewer_password',async ({password}={})=>{
        if(socket.data.role!=='admin'||typeof password!=='string'||password.length<8||password.length>128)return;
        const league=getLeague(socket.data.hostId);if(!league.room)return;
        league.room.viewerPassword=hashPassword(password);await immediateSaveToFirebase();socket.emit('room:password_saved');
    });
    socket.on('manager:login', ({ username, password }) => {
        const rawUser = (username || '').toString().trim();
        const target = rawUser.toLowerCase();
        const foundManager = findManagerKey(rawUser);
        const effectiveUser = foundManager || rawUser;

        if ((foundManager && matchesPassword(password, MANAGERS[foundManager])) || 
            (target === 'admin' && (!MANAGERS['admin'] || MANAGERS['admin'] === password))) {
            for(const room of socket.rooms)if(room!==socket.id)socket.leave(room);
            socket.data.role = 'admin';
            socket.data.hostId = effectiveUser;
            socket.data.teamId = null;
            socket.join(`host:${effectiveUser.toLowerCase()}`);
            socket.join(`admin:${effectiveUser.toLowerCase()}`);
            const hostLeague = getLeague(effectiveUser);
            socket.emit('manager:logged_in', { username: effectiveUser, state: publicState(hostLeague, true) });
        } else {
            socket.emit('auth:portal_error', 'Invalid Credentials');
        }
    });

    socket.on('participant:connect', (hostId) => {
        const rawHost = (hostId || 'admin').toString().trim();
        const foundManager = findManagerKey(rawHost);
        const isRegistered = !!foundManager || rawHost.toLowerCase() === 'admin';
        if (!isRegistered) {
            return socket.emit('init:teams_available', { hostId: rawHost, teams: [], notFound: true });
        }

        const canonicalHost = foundManager || rawHost;
        // Team selection is public; do not join the live state channel yet.
        const hostLeague = getLeague(canonicalHost);
        const safeTeams = (hostLeague.teams || []).map(({ password, ...t }) => t);
        socket.emit('init:teams_available', { hostId: canonicalHost, teams: safeTeams, notFound: false });
    });

    socket.on('team:login', ({ teamId, password, role, hostId }) => {
        const effectiveHost = findManagerKey(hostId || '');
        if (!effectiveHost || !['team','listener'].includes(role)) return socket.emit('auth:team_error','Room or access role is invalid');
        const hostLeague=getLeague(effectiveHost);
        const team=(hostLeague.teams || []).find(t => t.id === teamId);
        if(role==='team' && (!team || !matchesPassword(password,team.password)))return socket.emit('auth:team_error','Incorrect team password');
        if(role==='listener' && (!hostLeague.room?.viewerPassword || !matchesPassword(password,hostLeague.room.viewerPassword)))return socket.emit('auth:team_error','Incorrect viewer password');
        for(const room of socket.rooms)if(room!==socket.id)socket.leave(room);
        socket.data={hostId:effectiveHost,role,teamId:role==='team'?team.id:null};
        socket.join(`host:${effectiveHost.toLowerCase()}`);
        socket.emit('auction:enter',{role,teamId:socket.data.teamId,hostId:effectiveHost,state:publicState(hostLeague)});
        if(hostLeague.currentActivePlayer)socket.emit('popup:open',hostLeague.currentActivePlayer);
    });

    socket.on('admin:timer_control', (data) => {
        const hostId = socket.data.hostId || 'admin';
        const seconds = Number(data.time) || 30;
        const isPaused = !!data.paused;
        if (isPaused) {
            pauseHostTimer(hostId, seconds);
        } else {
            startHostTimer(hostId, seconds);
        }
    });
    
    function fisherYatesShuffle(array) {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // --- CODE SHUFFLE CONTROLS ---
    const shuffleCodes = (hostOverride) => {
        const hostId = hostOverride || socket.data.hostId || 'admin';
        const hostKey = hostId.toLowerCase();
        const league = getLeague(hostId);
        let { pool } = buildShufflePool(league);
        if (!pool || pool.length === 0) {
            socket.emit('admin:toast', { msg: '⚠️ No players on the player list to shuffle code. Please add players first.' });
            return;
        }
        pool = fisherYatesShuffle(pool);
        league.lotteryQueue = pool;
        league.codeShuffleActive = true;
        league.unsoldRoundActive = false;
        league.pickedPlayerCode = pool[0] ? (pool[0].code || makePlayerCode(pool[0].category, pool[0].name, new Set())) : null;
        if (hostKey === 'admin') {
            STATE.lotteryQueue = league.lotteryQueue;
            STATE.codeShuffleActive = league.codeShuffleActive;
            STATE.unsoldRoundActive = league.unsoldRoundActive;
            STATE.pickedPlayerCode = league.pickedPlayerCode;
            io.to('host:admin').emit('state:updated', publicState(STATE));
            io.to('host:admin').emit('code_shuffle:started', { hasActivePlayer: !!STATE.currentActivePlayer });
        }
        io.to(`host:${hostKey}`).emit('state:updated', publicState(league));
        io.to(`host:${hostKey}`).emit('code_shuffle:started', { hasActivePlayer: !!league.currentActivePlayer });
        immediateSaveToFirebase();
    };

    const shuffleUnsoldCodes = (hostOverride) => {
        const hostId = hostOverride || socket.data.hostId || 'admin';
        const hostKey = hostId.toLowerCase();
        const league = getLeague(hostId);
        let { unsoldPool } = buildShufflePool(league);
        if (!unsoldPool.length) {
            (league.categories || []).forEach(cat => {
                const players = (league.playersSnapshot && league.playersSnapshot[cat.id]) || [];
                players.forEach(p => {
                    const key = `${cat.id}:${p.name}`;
                    let isSold = false;
                    (league.teams || []).forEach(t => { if (t.purchases && t.purchases[cat.id] === p.name) isSold = true; });
                    if (!isSold && league.unsoldPlayers?.[key] && !unsoldPool.some(u => u.category === cat.id && u.name === p.name)) {
                        const usedCodes = new Set(unsoldPool.map(u => u.code));
                        unsoldPool.push({
                            category: cat.id,
                            name: p.name,
                            base: cat.base,
                            image: p.image,
                            code: makePlayerCode(cat.id, p.name, usedCodes),
                            isUnsold: true
                        });
                    }
                });
            });
        }
        if (!unsoldPool || unsoldPool.length === 0) {
            socket.emit('admin:toast', { msg: '⚠️ No unsold players on the player list to shuffle.' });
            return;
        }
        unsoldPool = fisherYatesShuffle(unsoldPool);
        league.lotteryQueue = unsoldPool;
        league.codeShuffleActive = true;
        league.unsoldRoundActive = true;
        league.pickedPlayerCode = unsoldPool[0] ? (unsoldPool[0].code || makePlayerCode(unsoldPool[0].category, unsoldPool[0].name, new Set())) : null;
        if (hostKey === 'admin') {
            STATE.lotteryQueue = league.lotteryQueue;
            STATE.codeShuffleActive = league.codeShuffleActive;
            STATE.unsoldRoundActive = league.unsoldRoundActive;
            STATE.pickedPlayerCode = league.pickedPlayerCode;
            io.to('host:admin').emit('state:updated', publicState(STATE));
            io.to('host:admin').emit('code_shuffle:started', { hasActivePlayer: !!STATE.currentActivePlayer, isUnsoldRound: true });
        }
        io.to(`host:${hostKey}`).emit('state:updated', publicState(league));
        io.to(`host:${hostKey}`).emit('code_shuffle:started', { hasActivePlayer: !!league.currentActivePlayer, isUnsoldRound: true });
        immediateSaveToFirebase();
    };

    socket.on('admin:shuffle_codes', shuffleCodes);
    socket.on('admin:generate_lottery', shuffleCodes);
    socket.on('admin:shuffle_unsold', shuffleUnsoldCodes);
    socket.on('admin:pick_code', () => {
        if (socket.data.role !== 'admin') return;
        const hostId = socket.data.hostId || 'admin';
        const hostKey = hostId.toLowerCase();
        const league = getLeague(hostId);
        
        // Find next player in queue that is not already purchased
        const queue = league.lotteryQueue || [];
        const next = queue.find(p => !(league.teams || []).some(t => t.purchases?.[p.category] === p.name));
        
        if (!next) {
            // Check if there are unqueued available players in snapshot pool
            const { pool, unsoldPool } = buildShufflePool(league);
            const totalAvailable = [...pool, ...unsoldPool];
            if (totalAvailable.length === 0) {
                socket.emit('admin:toast', { msg: '⚠️ No players on the player list to pick a code. Please add players first.' });
                return;
            }
            league.lotteryQueue = totalAvailable;
            const chosen = totalAvailable[0];
            league.pickedPlayerCode = chosen.code || makePlayerCode(chosen.category, chosen.name, new Set());
        } else {
            league.pickedPlayerCode = next.code || makePlayerCode(next.category, next.name, new Set());
        }

        if (hostKey === 'admin') STATE.pickedPlayerCode = league.pickedPlayerCode;
        io.to(`host:${hostKey}`).emit('state:updated', publicState(league));
        if (hostKey === 'admin') io.to('host:admin').emit('state:updated', publicState(STATE));
        immediateSaveToFirebase();
    });
    socket.on('admin:reset_codes', () => {
        const hostId = socket.data.hostId || 'admin';
        const hostKey = hostId.toLowerCase();
        const league = getLeague(hostId);
        league.currentActivePlayer = null;
        league.pickedPlayerCode = null;
        league.lotteryQueue = [];
        league.codeShuffleActive = false;
        league.unsoldRoundActive = false;
        league.biddingActive = false;
        const timer = getHostTimer(hostId);
        timer.paused = false;
        timer.time = 30;
        if (timer.interval) {
            clearInterval(timer.interval);
            timer.interval = null;
        }
        if (hostKey === 'admin') {
            STATE.currentActivePlayer = null;
            STATE.pickedPlayerCode = null;
            STATE.lotteryQueue = [];
            STATE.codeShuffleActive = false;
            STATE.unsoldRoundActive = false;
            STATE.biddingActive = false;
            TIMER_STATE = { paused: false, time: 30 };
            if (serverTimerInterval) {
                clearInterval(serverTimerInterval);
                serverTimerInterval = null;
            }
            io.to('host:admin').emit('popup:close');
            io.to('host:admin').emit('state:updated', publicState(STATE));
            io.to('host:admin').emit('admin:toast', { msg: '🔄 Code Shuffle & Unsold Round Deactivated' });
        }
        io.to(`host:${hostKey}`).emit('popup:close');
        io.to(`host:${hostKey}`).emit('state:updated', publicState(league));
        io.to(`host:${hostKey}`).emit('admin:toast', { msg: '🔄 Code Shuffle & Unsold Round Deactivated' });
        immediateSaveToFirebase();
    });

    socket.on('admin:start_bidding', () => {
        const hostId = socket.data.hostId || 'admin';
        startHostTimer(hostId, 30);
        immediateSaveToFirebase();
    });
    
    socket.on('admin:mark_unsold', ({ category, name }) => {
        const hostId = socket.data.hostId || 'admin';
        markPlayerUnsoldInternal(category, name, hostId);
    });

    socket.on('admin:save_team_rtm', async ({ teamId, selectedPlayers }) => {
        if (!teamId || !Array.isArray(selectedPlayers)) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        if (!targetLeague.previousOwners) targetLeague.previousOwners = {};

        // Remove previous RTM tags assigned to this team
        Object.keys(targetLeague.previousOwners).forEach(key => {
            if (targetLeague.previousOwners[key] === teamId) delete targetLeague.previousOwners[key];
        });

        // Add the selected RTM tags
        selectedPlayers.forEach(p => {
            if (p.catId && p.name) {
                targetLeague.previousOwners[`${p.catId}:${p.name}`] = teamId;
            }
        });

        if (hostId.toLowerCase() === 'admin') {
            STATE.previousOwners = targetLeague.previousOwners;
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `RTM tags updated & saved` });
        await immediateSaveToFirebase();
    });

    socket.on('admin:set_previous_owners', async ({ previousOwners }) => {
        if (typeof previousOwners === 'object' && previousOwners !== null) {
            const hostId = socket.data.hostId || 'admin';
            const targetLeague = getLeague(hostId);
            targetLeague.previousOwners = previousOwners;
            if (hostId.toLowerCase() === 'admin') {
                STATE.previousOwners = previousOwners;
            }
            broadcastLeagueUpdate(hostId, targetLeague);
            await immediateSaveToFirebase();
        }
    });

    socket.on('admin:remove_previous', async ({ teamId, players, previousOwners }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        if (previousOwners && typeof previousOwners === 'object') {
            targetLeague.previousOwners = previousOwners;
        } else if (teamId && Array.isArray(players)) {
            if (!targetLeague.previousOwners) targetLeague.previousOwners = {};
            players.forEach(p => {
                const key = `${p.catId}:${p.name}`;
                if (targetLeague.previousOwners[key] === teamId) delete targetLeague.previousOwners[key];
            });
        }
        if (hostId.toLowerCase() === 'admin') {
            STATE.previousOwners = targetLeague.previousOwners;
        }
        broadcastLeagueUpdate(hostId, targetLeague);
        await immediateSaveToFirebase();
    });

    socket.on('admin:import_previous', async ({ teamId, players }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        if (!targetLeague.previousOwners) targetLeague.previousOwners = {};
        let added = 0, skipped = 0;
        players.forEach(p => {
            const key = `${p.catId}:${p.name}`;
            const currentOwner = targetLeague.previousOwners[key];
            if (currentOwner && currentOwner !== teamId) {
                skipped++;
                return;
            }
            targetLeague.previousOwners[key] = teamId;
            added++;
        });
        if (hostId.toLowerCase() === 'admin') {
            STATE.previousOwners = targetLeague.previousOwners;
        }
        broadcastLeagueUpdate(hostId, targetLeague);
        if (skipped) io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `Skipped ${skipped} player(s) already tagged to another team` });
        if (added) io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `Tagged ${added} player(s)` });
        await immediateSaveToFirebase();
    });

    socket.on('rtm:lockImpact', ({ category, name, rtmTeamId }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const team = (targetLeague.teams || []).find(t => t.id === rtmTeamId);
        const key = `${category}:${name}`;
        if (!team || team.rtmUsed || (team.purchases && team.purchases[category]) || !targetLeague.previousOwners || targetLeague.previousOwners[key] !== rtmTeamId) return;
        if (!targetLeague.rtmImpactLocks) targetLeague.rtmImpactLocks = {};
        if (!targetLeague.rtmImpactLocks[key]) targetLeague.rtmImpactLocks[key] = {};
        targetLeague.rtmImpactLocks[key][rtmTeamId] = true;
        if (hostId.toLowerCase() === 'admin') {
            STATE.rtmImpactLocks = targetLeague.rtmImpactLocks;
        }
        pauseServerTimer(hostId);
        broadcastLeagueUpdate(hostId, targetLeague);
        debouncedSaveToFirebase();
    });

    socket.on('team:activateImpact', async ({ teamId, category, playerName }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        if (!socket.data.teamId && teamId) {
            const matchedTeam = (targetLeague.teams || []).find(t => String(t.id).toUpperCase() === String(teamId).toUpperCase());
            if (matchedTeam) {
                socket.data.teamId = matchedTeam.id;
                socket.data.role = socket.data.role || 'team';
            }
        }
        if (teamId && String(socket.data.teamId || '').toUpperCase() !== String(teamId || '').toUpperCase() && socket.data.role !== 'admin') {
            socket.emit('admin:toast', { msg: '❌ Not authorized for this franchise', type: 'impact' });
            return;
        }
        const team = (targetLeague.teams || []).find(t => t.id === teamId);
        const bonus = Number((targetLeague.config && targetLeague.config.impactAmount) || STATE.config.impactAmount) || 0;
        if (isRTMImpactLocked(teamId, category, playerName, hostId)) {
            io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `⚡ Impact locked: ${team ? team.name : teamId} has RTM available for ${playerName}`, type: 'rtm' });
            return;
        }
        if (team && !team.impactUsed && !team.impactActive && bonus > 0) {
            team.purse = Number(team.purse) + bonus;
            team.impactActive = true;
            team.impactUsed = true; 
            team.impactTarget = `${category}:${playerName}`; 
            if (hostId.toLowerCase() === 'admin') {
                const adminTeam = (STATE.teams || []).find(t => t.id === teamId);
                if (adminTeam) {
                    adminTeam.purse = team.purse;
                    adminTeam.impactActive = true;
                    adminTeam.impactUsed = true;
                    adminTeam.impactTarget = team.impactTarget;
                }
            }
            io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `⚡ IMPACT: ${team.name} on ${playerName}`, type: 'impact' });
            broadcastLeagueUpdate(hostId, targetLeague);
            await immediateSaveToFirebase();
        }
    });

    socket.on('admin:resetImpact', async ({ teamId }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const team = (targetLeague.teams || []).find(t => t.id === teamId);
        const bonus = Number((targetLeague.config && targetLeague.config.impactAmount) || STATE.config.impactAmount) || 0;
        if (team) {
            if (team.impactActive) team.purse = Math.max(0, Number(team.purse) - bonus); 
            team.impactUsed = false;
            team.impactActive = false;
            team.impactTarget = null;
            if (hostId.toLowerCase() === 'admin') {
                const adminTeam = (STATE.teams || []).find(t => t.id === teamId);
                if (adminTeam) {
                    adminTeam.purse = team.purse;
                    adminTeam.impactUsed = false;
                    adminTeam.impactActive = false;
                    adminTeam.impactTarget = null;
                }
            }
            io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `↩️ Impact Reset for ${team.name}`, type: 'normal' });
            broadcastLeagueUpdate(hostId, targetLeague);
            await immediateSaveToFirebase();
        }
    });

    socket.on('admin:resetTeam', async ({ teamId }) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const team = (targetLeague.teams || []).find(t => t.id === teamId);
        if (team) {
            team.purse = 500;
            if (targetLeague.directSigns) { for (const cat in team.purchases) { delete targetLeague.directSigns[`${cat}:${team.purchases[cat]}`]; } }
            if (targetLeague.rtmEvents) { for (const cat in team.purchases) { delete targetLeague.rtmEvents[`${cat}:${team.purchases[cat]}`]; } }
            if (targetLeague.rtmImpactLocks) { for (const cat in team.purchases) { delete targetLeague.rtmImpactLocks[`${cat}:${team.purchases[cat]}`]; } }
            team.purchases = {};
            team.impactUsed = false;
            team.impactActive = false;
            team.impactTarget = null;
            team.directSignUsed = false; 
            team.rtmUsed = false;

            if (hostId.toLowerCase() === 'admin') {
                const adminTeam = (STATE.teams || []).find(t => t.id === teamId);
                if (adminTeam) {
                    adminTeam.purse = 500;
                    if (STATE.directSigns) { for (const cat in adminTeam.purchases) { delete STATE.directSigns[`${cat}:${adminTeam.purchases[cat]}`]; } }
                    if (STATE.rtmEvents) { for (const cat in adminTeam.purchases) { delete STATE.rtmEvents[`${cat}:${adminTeam.purchases[cat]}`]; } }
                    if (STATE.rtmImpactLocks) { for (const cat in adminTeam.purchases) { delete STATE.rtmImpactLocks[`${cat}:${adminTeam.purchases[cat]}`]; } }
                    adminTeam.purchases = {};
                    adminTeam.impactUsed = false;
                    adminTeam.impactActive = false;
                    adminTeam.impactTarget = null;
                    adminTeam.directSignUsed = false;
                    adminTeam.rtmUsed = false;
                }
            }

            io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `Team ${team.name} Reset`, type: 'normal' });
            broadcastLeagueUpdate(hostId, targetLeague);
            await immediateSaveToFirebase();
        }
    });

    socket.on('admin:resetPlayer', async ({ category, name }) => {
        if (socket.data.role !== 'admin') {
            socket.emit('admin:toast', { msg: '❌ Only admin can reset a player', type: 'normal' });
            return;
        }

        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const key = `${category}:${name}`;
        const cat = (targetLeague.categories || STATE.categories || []).find(c => c.id === category);
        const basePrice = Number(cat?.base) || 0;
        const soldPrice = Number(targetLeague.soldPrices && targetLeague.soldPrices[key]) || Number(targetLeague.activeBids && targetLeague.activeBids[key]) || basePrice;
        const buyer = (targetLeague.teams || []).find(t => t.purchases && t.purchases[category] === name);
        const wasDirect = !!(targetLeague.directSigns && targetLeague.directSigns[key]);
        const wasRTM = !!(targetLeague.rtmEvents && targetLeague.rtmEvents[key]);
        const impactBonus = Number((targetLeague.config && targetLeague.config.impactAmount) || STATE.config.impactAmount) || 0;

        if (buyer) {
            buyer.purse = Number(buyer.purse) + soldPrice;
            delete buyer.purchases[category];
            if (wasDirect) buyer.directSignUsed = false;
            if (wasRTM) buyer.rtmUsed = false;
        }

        (targetLeague.teams || []).forEach(t => {
            if (t.impactTarget === key) {
                if (t.impactActive || (buyer && t.id === buyer.id)) t.purse = Math.max(0, Number(t.purse) - impactBonus);
                t.impactUsed = false;
                t.impactActive = false;
                t.impactTarget = null;
            }
        });

        if (!targetLeague.activeBids) targetLeague.activeBids = {};
        if (!targetLeague.activeBidders) targetLeague.activeBidders = {};
        targetLeague.activeBids[key] = basePrice;
        delete targetLeague.activeBidders[key];
        if (targetLeague.soldPrices) delete targetLeague.soldPrices[key];
        if (targetLeague.directSigns) delete targetLeague.directSigns[key];
        if (targetLeague.rtmEvents) delete targetLeague.rtmEvents[key];
        if (targetLeague.unsoldPlayers) delete targetLeague.unsoldPlayers[key];
        if (targetLeague.rtmImpactLocks) delete targetLeague.rtmImpactLocks[key];
        if (targetLeague.rtmState && targetLeague.rtmState.category === category && targetLeague.rtmState.name === name) {
            targetLeague.rtmState = null;
            io.to(`host:${hostId.toLowerCase()}`).emit('rtm:cleared');
        }

        if (hostId.toLowerCase() === 'admin') {
            if (STATE.soldPrices) delete STATE.soldPrices[key];
            if (STATE.directSigns) delete STATE.directSigns[key];
            if (STATE.rtmEvents) delete STATE.rtmEvents[key];
            if (STATE.unsoldPlayers) delete STATE.unsoldPlayers[key];
            if (STATE.rtmImpactLocks) delete STATE.rtmImpactLocks[key];
            if (!STATE.activeBids) STATE.activeBids = {};
            STATE.activeBids[key] = basePrice;
            if (STATE.activeBidders) delete STATE.activeBidders[key];
            if (STATE.rtmState && STATE.rtmState.category === category && STATE.rtmState.name === name) {
                STATE.rtmState = null;
            }
            const adminBuyer = (STATE.teams || []).find(t => t.purchases && t.purchases[category] === name);
            if (adminBuyer) {
                adminBuyer.purse = Number(adminBuyer.purse) + soldPrice;
                delete adminBuyer.purchases[category];
                if (wasDirect) adminBuyer.directSignUsed = false;
                if (wasRTM) adminBuyer.rtmUsed = false;
            }
        }

        io.to(`host:${hostId.toLowerCase()}`).emit('player:bid', { category, name, price: basePrice, highBidderId: null, teamId: null });
        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `↩️ ${name} reset to base ৳${basePrice}${buyer ? ` and ৳${soldPrice} refunded to ${buyer.name}` : ''}`, type: 'normal' });
        await immediateSaveToFirebase();
    });

    socket.on('admin:select_player', (playerData) => {
        const hostId=socket.data.hostId;const league=getLeague(hostId);
        const category=league.categories.find(c=>c.id===playerData.category);
        const player=(league.playersSnapshot[playerData.category]||[]).find(p=>p.name===playerData.name);
        if(!category||!player)return;
        const selectedPlayer={...playerData,base:category.base,currentPrice:league.activeBids[`${category.id}:${player.name}`]||category.base,revealStartedAt:playerData.revealCode?Date.now()+PLAYER_REVEAL_DELAY_MS:null};
        league.currentActivePlayer=selectedPlayer;league.biddingActive=false;
        pauseHostTimer(hostId,30);broadcastLeagueUpdate(hostId,league);
        io.to(`host:${hostId.toLowerCase()}`).emit('popup:open',selectedPlayer);
        immediateSaveToFirebase();
    });

    socket.on('admin:adjust_bid', ({ category, name, price, delta, action }) => {
        if (socket.data.role !== 'admin') return;
        const hostId = socket.data.hostId || 'admin';
        const hostKey = hostId.toString().toLowerCase();
        const league = getLeague(hostId);

        if (!league.activeBids) league.activeBids = {};
        const key = `${category}:${name}`;
        const newPrice = Math.max(0, Number(price) || 0);
        league.activeBids[key] = newPrice;
        if (league.currentActivePlayer && league.currentActivePlayer.name === name) {
            league.currentActivePlayer.currentPrice = newPrice;
            league.currentActivePlayer.adminAdjusted = true;
        }

        const currentBidder = league.activeBidders ? league.activeBidders[key] : null;
        const bidderTeam = currentBidder ? (league.teams || []).find(t => t.id === currentBidder) : null;
        
        const actionVerb = action || (delta >= 0 ? 'increased' : 'decreased');
        const textMsg = `Auctioneer ${actionVerb} bid to ৳${newPrice}`;

        const bidPayload = {
            category,
            name,
            price: newPrice,
            highBidderId: currentBidder,
            teamId: currentBidder,
            teamName: bidderTeam ? bidderTeam.name : (currentBidder || 'Admin Desk'),
            isAdjustment: true,
            adjustmentText: `📢 ${textMsg}`
        };

        if (hostKey === 'admin') {
            if (!STATE.activeBids) STATE.activeBids = {};
            STATE.activeBids[key] = newPrice;
            if (STATE.currentActivePlayer && STATE.currentActivePlayer.name === name) {
                STATE.currentActivePlayer.currentPrice = newPrice;
                STATE.currentActivePlayer.adminAdjusted = true;
            }
            io.to('host:admin').emit('player:bid', bidPayload);
            io.to('host:admin').emit('admin:toast', { msg: `📢 ${textMsg}` });
        }

        io.to(`host:${hostKey}`).emit('player:bid', bidPayload);
        io.to(`host:${hostKey}`).emit('admin:toast', { msg: `📢 ${textMsg}` });
        immediateSaveToFirebase();
    });

    socket.on('admin:start_timer', () => {
        if (socket.data.role !== 'admin') return;
        const hostId = socket.data.hostId || 'admin';
        startHostTimer(hostId);
    });

    socket.on('admin:close_popup', () => { 
        const hostId = socket.data.hostId || 'admin';
        const hostKey = hostId.toString().toLowerCase();
        const league = getLeague(hostId);
        league.currentActivePlayer = null; 
        league.biddingActive = false;
        const timer = getHostTimer(hostId);
        timer.paused = false;
        timer.time = 30;
        if (timer.interval) {
            clearInterval(timer.interval);
            timer.interval = null;
        }
        if (hostKey === 'admin') {
            STATE.currentActivePlayer = null; 
            STATE.biddingActive = false;
            TIMER_STATE = { paused: false, time: 30 }; 
            if (serverTimerInterval) {
                clearInterval(serverTimerInterval);
                serverTimerInterval = null;
            }
            io.to('host:admin').emit('popup:close');
        }
        io.to(`host:${hostKey}`).emit('popup:close');
        immediateSaveToFirebase(); 
    });

    socket.on('player:bid', (data) => {
        if (!data) return;
        const hostId = socket.data.hostId || 'admin';
        const hostKey = hostId.toString().toLowerCase();
        const league = getLeague(hostId);

        if (socket.data.role !== 'admin' && socket.data.role !== 'team') {
            socket.emit('admin:toast', { msg: '❌ Sign in as a franchise before placing a bid' });
            return;
        }
        if (socket.data.role === 'team' && String(socket.data.teamId || '').toUpperCase() !== String(data.teamId || '').toUpperCase()) {
            socket.emit('admin:toast', { msg: '❌ Not authorized for this franchise' });
            return;
        }
        const validPrice = Number(data.price);
        if (isNaN(validPrice) || validPrice <= 0) return;

        const key = `${data.category}:${data.name}`;
        const team = data.teamId ? (league.teams || []).find(t => t.id === data.teamId) : null;
        const timer = getHostTimer(hostId);

        // Team bid validation
        if (data.teamId) {
            if (!league.biddingActive) {
                socket.emit('admin:toast', { msg: '⚠️ Bidding has not started yet' });
                return;
            }
            if (timer.paused) {
                socket.emit('admin:toast', { msg: '⏸️ Bidding is currently paused' });
                return;
            }
            if (!team) {
                socket.emit('admin:toast', { msg: '❌ Franchise not found' });
                return;
            }
            if (league.activeBidders && league.activeBidders[key] === data.teamId && socket.data.role !== 'admin') {
                socket.emit('admin:toast', { msg: '✋ You are already the highest bidder for this player' });
                return;
            }
            if (Number(team.purse) < validPrice) {
                socket.emit('admin:toast', { msg: `❌ Insufficient purse balance (Purse: ৳${team.purse})` });
                return;
            }
            const reserve = getSaleReserve(team, data.category, league);
            if ((Number(team.purse) - validPrice) < reserve) {
                socket.emit('admin:toast', { msg: `❌ Must reserve ৳${reserve} for remaining required slots!` });
                return;
            }
        }

        const currentTopBid = Number(league.activeBids && league.activeBids[key]) || 0;
        const currentTopBidder = league.activeBidders ? league.activeBidders[key] : null;

        if (currentTopBidder && currentTopBidder !== 'ADMIN' && validPrice <= currentTopBid && data.teamId && data.teamId !== 'ADMIN') {
            socket.emit('admin:toast', { msg: `⚠️ Bid must be higher than current bid (৳${currentTopBid})` });
            return;
        }

        if (!league.activeBids) league.activeBids = {};
        if (!league.activeBidders) league.activeBidders = {};

        league.activeBids[key] = validPrice;
        league.activeBidders[key] = data.teamId ? data.teamId : 'ADMIN';

        if (league.currentActivePlayer && league.currentActivePlayer.name === data.name) {
            league.currentActivePlayer.currentPrice = validPrice;
            if (data.teamId && data.teamId !== 'ADMIN') {
                league.currentActivePlayer.adminAdjusted = false;
            }
        }

        // Reset timer back to 30s on every valid bid
        if (league.biddingActive) {
            startHostTimer(hostId, 30);
        }

        const bidPayload = { ...data, price: validPrice, highBidderId: league.activeBidders[key], teamName: team ? team.name : 'Admin Desk' };
        io.to(`host:${hostKey}`).emit('player:bid', bidPayload);

        if (hostKey === 'admin') {
            if (!STATE.activeBids) STATE.activeBids = {};
            if (!STATE.activeBidders) STATE.activeBidders = {};
            STATE.activeBids[key] = validPrice;
            STATE.activeBidders[key] = league.activeBidders[key];
            if (STATE.currentActivePlayer && STATE.currentActivePlayer.name === data.name) {
                STATE.currentActivePlayer.currentPrice = validPrice;
                if (data.teamId && data.teamId !== 'ADMIN') {
                    STATE.currentActivePlayer.adminAdjusted = false;
                }
            }
            io.to('host:admin').emit('player:bid', bidPayload);
        }
        
        // AUTO-SELL CHECK:
        // If a team who has NOT bought anything from this category bids for this player,
        // AND this player is the last remaining player in this category (or unfulfilled teams <= 1):
        if (data.teamId && team && !team.purchases?.[data.category]) {
            const categoryId = data.category;
            const categoryPlayers = (league.playersSnapshot?.[categoryId] || []);
            const soldInCat = new Set();
            (league.teams || []).forEach(t => {
                if (t.purchases && t.purchases[categoryId]) {
                    soldInCat.add(t.purchases[categoryId]);
                }
            });
            const unacquiredCount = categoryPlayers.filter(p => !soldInCat.has(p.name)).length;
            const unfulfilledTeamsForCat = (league.teams || []).filter(t => !t.purchases?.[categoryId]);

            const isLastPlayerInCategory = unacquiredCount <= 1;
            const isSingleUnfulfilledTeam = unfulfilledTeamsForCat.length <= 1;

            if (isLastPlayerInCategory || isSingleUnfulfilledTeam) {
                const soldSuccess = executeSale({
                    category: data.category,
                    name: data.name,
                    price: validPrice,
                    teamId: data.teamId,
                    isDirect: false,
                    isRTM: false
                }, hostId);
                if (soldSuccess) {
                    const toastMsg = `⚡ AUTO-SOLD: ${data.name} to ${team.name} @ ৳${validPrice}!`;
                    io.to(`host:${hostKey}`).emit('admin:toast', { msg: toastMsg });
                    if (hostKey === 'admin') io.to('host:admin').emit('admin:toast', { msg: toastMsg });
                    return;
                }
            }
        }

        debouncedSaveToFirebase();
    });

    socket.on('player:sold', (data) => { 
        if (socket.data.role !== 'admin') {
            socket.emit('admin:toast', { msg: '❌ Only admin can mark player sold' });
            return;
        }
        const hostId = socket.data.hostId || 'admin';
        executeSale(data, hostId); 
    });

    // --- RTM Phase 1: Team Sets Price + Match High Bidder ---
    socket.on('rtm:invoke', ({ category, name, rtmTeamId, manualHighBidderId, rtmPrice }) => {
        const hostId=socket.data.hostId; const STATE=getLeague(hostId);
        if (!socket.data.teamId && rtmTeamId) {
            const matchedTeam = STATE.teams.find(t => String(t.id).toUpperCase() === String(rtmTeamId).toUpperCase());
            if (matchedTeam) {
                socket.data.teamId = matchedTeam.id;
                socket.data.role = socket.data.role || 'team';
            }
        }
        if (rtmTeamId && String(socket.data.teamId || '').toUpperCase() !== String(rtmTeamId || '').toUpperCase() && socket.data.role !== 'admin') {
            socket.emit('admin:toast', { msg: '❌ Not authorized to invoke RTM for this franchise', type: 'rtm' });
            return;
        }
        const key = `${category}:${name}`;
        const validation = validateRTMOffer({ category, name, rtmTeamId, rtmPrice }, STATE);
        if (!validation.ok) {
            io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: validation.msg, type: 'rtm' });
            return;
        }
        const highBidder = manualHighBidderId || (STATE.activeBidders ? STATE.activeBidders[key] : null);
        const priceToMatch = validation.price;

        validation.team.rtmUsed = true;
        pauseServerTimer(hostId);
        if (!STATE.rtmImpactLocks) STATE.rtmImpactLocks = {};
        if (!STATE.rtmImpactLocks[key]) STATE.rtmImpactLocks[key] = {};
        STATE.rtmImpactLocks[key][rtmTeamId] = true;

        // If no one else has bid, sell it directly to the RTM team at their chosen RTM amount.
        if (!highBidder || highBidder === rtmTeamId) {
            executeSale({ category, name, price: priceToMatch, teamId: rtmTeamId, isDirect: true, isRTM: true }, hostId);
            return;
        }

        // Send prompt to the high bidder to accept or decline the incremented RTM matching price
        STATE.rtmState = { category, name, rtmTeamId, originalTeamId: highBidder, newPrice: priceToMatch };
        io.to(`host:${hostId.toLowerCase()}`).emit('state:updated', publicState(STATE));
        io.to(`host:${hostId.toLowerCase()}`).emit('rtm:prompt', STATE.rtmState);
        immediateSaveToFirebase();
    });

    // --- RTM Phase 2: High Bidder Responds ---
    socket.on('rtm:respond', ({ accept }) => {
        const hostId=socket.data.hostId; const STATE=getLeague(hostId);
        if(socket.data.role!=='admin' && socket.data.teamId!==STATE.rtmState?.originalTeamId)return;
        if (!STATE.rtmState) return;
        const { category, name, rtmTeamId, originalTeamId, newPrice } = STATE.rtmState;
        
        STATE.rtmState = null;
        io.to(`host:${hostId.toLowerCase()}`).emit('state:updated', publicState(STATE));
        io.to(`host:${hostId.toLowerCase()}`).emit('rtm:cleared');

        if (accept) {
            // Original high bidder matched the new price
            const matched = executeSale({ category, name, price: newPrice, teamId: originalTeamId, isDirect: false, isRTM: false }, hostId);
            if (!matched) executeSale({ category, name, price: newPrice, teamId: rtmTeamId, isDirect: true, isRTM: true }, hostId);
        } else {
            // Original bidder declined, RTM Team wins it at the new price
            executeSale({ category, name, price: newPrice, teamId: rtmTeamId, isDirect: true, isRTM: true }, hostId);
        }
    });

    socket.on('admin:setTeamLogo', async ({ teamId, logoUrl }) => {
        if (!teamId || !logoUrl) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const team = (targetLeague.teams || []).find(t => t.id === teamId);
        if (!team) return;
        team.logo = logoUrl;
        if (hostId.toLowerCase() === 'admin') {
            const adminTeam = (STATE.teams || []).find(t => t.id === teamId);
            if (adminTeam) adminTeam.logo = logoUrl;
        }
        broadcastLeagueUpdate(hostId, targetLeague);
        await immediateSaveToFirebase();
    });

    socket.on('team:submit_database', async ({category,names}={}) => {
        if(socket.data.role!=='team'||!Array.isArray(names)||names.length>500)return;
        const league=getLeague(socket.data.hostId);if(!league.categories.some(c=>c.id===category))return;
        const players=league.playersSnapshot[category] ||= [];const existing=new Set(players.map(p=>p.name.toLowerCase()));let count=0;
        for(const name of names){if(typeof name!=='string'||!name.trim()||name.length>100)continue;const cleaned=name.trim();if(existing.has(cleaned.toLowerCase()))continue;players.push({name:cleaned,image:'',submittedBy:socket.data.teamId});existing.add(cleaned.toLowerCase());count++;}
        await immediateSaveToFirebase();broadcastLeagueUpdate(socket.data.hostId,league);socket.emit('team:database_saved',{count});
    });
    socket.on('players:save', async ({ category, players }) => {
        if (!category || !Array.isArray(players)) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        if (!targetLeague.playersSnapshot) targetLeague.playersSnapshot = {};
        targetLeague.playersSnapshot[category] = players;
        targetLeague.lotteryQueue = (targetLeague.lotteryQueue || []).map(qp => {
            if (qp.category !== category) return qp;
            const updated = players.find(p => p.name === qp.name);
            return updated ? { ...qp, image: updated.image, name: updated.name, base: qp.base } : qp;
        });

        if (targetLeague.currentActivePlayer && targetLeague.currentActivePlayer.category === category) {
            const updatedActive = players.find(p => p.name === targetLeague.currentActivePlayer.name);
            if (updatedActive) {
                targetLeague.currentActivePlayer = { ...targetLeague.currentActivePlayer, ...updatedActive, image: updatedActive.image || targetLeague.currentActivePlayer.image };
                io.to(`host:${hostId.toLowerCase()}`).emit('popup:update_image', { imageUrl: targetLeague.currentActivePlayer.image });
            }
        }

        if (hostId.toLowerCase() === 'admin') {
            STATE.playersSnapshot = targetLeague.playersSnapshot;
            STATE.lotteryQueue = targetLeague.lotteryQueue;
            STATE.currentActivePlayer = targetLeague.currentActivePlayer;
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        await immediateSaveToFirebase();
    });

    socket.on('players:clear', async ({ category }) => {
        if (!category) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        if (!targetLeague.playersSnapshot) targetLeague.playersSnapshot = {};
        targetLeague.playersSnapshot[category] = [];
        targetLeague.lotteryQueue = (targetLeague.lotteryQueue || []).filter(p => p.category !== category);

        if (hostId.toLowerCase() === 'admin') {
            STATE.playersSnapshot = targetLeague.playersSnapshot;
            STATE.lotteryQueue = targetLeague.lotteryQueue;
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        await immediateSaveToFirebase();
    });

    socket.on('admin:deleteCategory', async ({ id }) => {
        if (!id) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        targetLeague.categories = (targetLeague.categories || []).filter(c => c.id !== id);
        if (targetLeague.playersSnapshot) delete targetLeague.playersSnapshot[id];
        targetLeague.lotteryQueue = (targetLeague.lotteryQueue || []).filter(p => p.category !== id);

        if (hostId.toLowerCase() === 'admin') {
            STATE.categories = targetLeague.categories;
            if (STATE.playersSnapshot) delete STATE.playersSnapshot[id];
            STATE.lotteryQueue = targetLeague.lotteryQueue;
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `Category ${id} deleted` });
        await immediateSaveToFirebase();
    });

    socket.on('admin:move_player_category', async ({ sourceCategory, targetCategory, playerName }) => {
        if (!sourceCategory || !targetCategory || !playerName || sourceCategory === targetCategory) return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        if (!targetLeague.playersSnapshot || !targetLeague.playersSnapshot[sourceCategory] || !targetLeague.playersSnapshot[targetCategory]) return;
        
        const index = targetLeague.playersSnapshot[sourceCategory].findIndex(p => p.name === playerName);
        if (index === -1) return;
        
        const targetCatObj = (targetLeague.categories || []).find(c => c.id === targetCategory);
        const targetBasePrice = Number(targetCatObj?.base) || 0;
        const targetIncrement = Number(targetCatObj?.increment) || 0;

        const [movedPlayer] = targetLeague.playersSnapshot[sourceCategory].splice(index, 1);
        movedPlayer.category = targetCategory;
        if (targetCatObj) {
            movedPlayer.base = targetBasePrice;
            movedPlayer.price = targetBasePrice;
            movedPlayer.increment = targetIncrement;
        }
        targetLeague.playersSnapshot[targetCategory].push(movedPlayer);

        const oldKey = `${sourceCategory}:${playerName}`;
        const newKey = `${targetCategory}:${playerName}`;

        if (targetLeague.previousOwners && targetLeague.previousOwners[oldKey]) {
            targetLeague.previousOwners[newKey] = targetLeague.previousOwners[oldKey];
            delete targetLeague.previousOwners[oldKey];
        }
        if (targetLeague.activeBids) {
            targetLeague.activeBids[newKey] = targetBasePrice;
            delete targetLeague.activeBids[oldKey];
        }
        if (targetLeague.activeBidders && targetLeague.activeBidders[oldKey]) {
            targetLeague.activeBidders[newKey] = targetLeague.activeBidders[oldKey];
            delete targetLeague.activeBidders[oldKey];
        }
        if (targetLeague.soldPrices && targetLeague.soldPrices[oldKey] !== undefined) {
            targetLeague.soldPrices[newKey] = targetBasePrice;
            delete targetLeague.soldPrices[oldKey];
        }
        if (targetLeague.directSigns && targetLeague.directSigns[oldKey]) {
            targetLeague.directSigns[newKey] = true;
            delete targetLeague.directSigns[oldKey];
        }
        if (targetLeague.rtmEvents && targetLeague.rtmEvents[oldKey]) {
            targetLeague.rtmEvents[newKey] = true;
            delete targetLeague.rtmEvents[oldKey];
        }
        if (targetLeague.unsoldPlayers && targetLeague.unsoldPlayers[oldKey]) {
            targetLeague.unsoldPlayers[newKey] = true;
            delete targetLeague.unsoldPlayers[oldKey];
        }

        (targetLeague.teams || []).forEach(t => {
            if (t.purchases && t.purchases[sourceCategory] === playerName) {
                delete t.purchases[sourceCategory];
                t.purchases[targetCategory] = playerName;
            }
        });

        if (targetLeague.lotteryQueue && Array.isArray(targetLeague.lotteryQueue)) {
            targetLeague.lotteryQueue.forEach(qp => {
                if (qp.category === sourceCategory && qp.name === playerName) {
                    qp.category = targetCategory;
                    if (targetCatObj) qp.base = targetBasePrice;
                }
            });
        }

        if (targetLeague.currentActivePlayer && targetLeague.currentActivePlayer.category === sourceCategory && targetLeague.currentActivePlayer.name === playerName) {
            targetLeague.currentActivePlayer.category = targetCategory;
            if (targetCatObj) {
                targetLeague.currentActivePlayer.base = targetBasePrice;
                targetLeague.currentActivePlayer.currentPrice = targetBasePrice;
            }
        }

        if (hostId.toLowerCase() === 'admin') {
            STATE.playersSnapshot = targetLeague.playersSnapshot;
            STATE.categories = targetLeague.categories;
            STATE.teams = targetLeague.teams;
            STATE.soldPrices = targetLeague.soldPrices;
            STATE.activeBids = targetLeague.activeBids;
            STATE.activeBidders = targetLeague.activeBidders;
            STATE.previousOwners = targetLeague.previousOwners;
            STATE.directSigns = targetLeague.directSigns;
            STATE.rtmEvents = targetLeague.rtmEvents;
            STATE.unsoldPlayers = targetLeague.unsoldPlayers;
            STATE.lotteryQueue = targetLeague.lotteryQueue;
            STATE.currentActivePlayer = targetLeague.currentActivePlayer;
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${hostId.toLowerCase()}`).emit('admin:toast', { msg: `🚚 Moved ${playerName} to ${targetCategory} (Base: ৳${targetBasePrice}, Step: ৳${targetIncrement})` });
        await immediateSaveToFirebase();
    });

    socket.on('admin:updateConfig', async (newConfig) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        if (newConfig.teams && Array.isArray(newConfig.teams)) {
            if(newConfig.teams.some(t=>!t||typeof t.id!=='string'||!t.id.trim()||typeof t.name!=='string'||!t.name.trim()||typeof t.password!=='string'||!t.password.trim()||!Number.isFinite(Number(t.purse))||Number(t.purse)<0)||new Set(newConfig.teams.map(t=>t.id.toUpperCase())).size!==newConfig.teams.length)return socket.emit('admin:toast',{msg:'Teams require unique IDs, names, passwords, and valid purses'});
            targetLeague.teams = newConfig.teams.map(nt => {
                const ot = (targetLeague.teams || []).find(t => t.id === nt.id); 
                const preservedPassword = (nt.password && String(nt.password).trim() !== '')
                    ? String(nt.password).trim()
                    : (ot && ot.password ? String(ot.password).trim() : '123');
                return { 
                    ...nt, 
                    password: preservedPassword,
                    purchases: (nt.purchases !== undefined) ? nt.purchases : (ot && ot.purchases ? ot.purchases : {}),
                    impactActive: (nt.impactActive !== undefined) ? nt.impactActive : (ot ? ot.impactActive : false),
                    rtmUsed: (nt.rtmUsed !== undefined) ? nt.rtmUsed : (ot ? ot.rtmUsed : false)
                };
            });
            if (hostId.toLowerCase() === 'admin') {
                STATE.teams = targetLeague.teams;
            }
        }
        if (newConfig.impactAmount !== undefined) {
            if (!targetLeague.config) targetLeague.config = {};
            targetLeague.config.impactAmount = Number(newConfig.impactAmount) || 0;
            if (hostId.toLowerCase() === 'admin') {
                if (!STATE.config) STATE.config = {};
                STATE.config.impactAmount = targetLeague.config.impactAmount;
            }
        }
        if (newConfig.categories && Array.isArray(newConfig.categories)) {
            targetLeague.categories = newConfig.categories;
            if (hostId.toLowerCase() === 'admin') {
                STATE.categories = targetLeague.categories;
            }
        }
        if (newConfig.previousOwners !== undefined) {
            targetLeague.previousOwners = newConfig.previousOwners;
            if (hostId.toLowerCase() === 'admin') {
                STATE.previousOwners = targetLeague.previousOwners;
            }
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        await immediateSaveToFirebase();
    });

    socket.on('admin:resetAll', async () => { 
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);

        // 1. Gather all players to permanently purge from Firebase Storage
        const allPlayers = [];
        if (targetLeague.playersSnapshot) {
            Object.values(targetLeague.playersSnapshot).forEach(list => {
                if (Array.isArray(list)) allPlayers.push(...list);
            });
        }
        if (targetLeague.currentActivePlayer) allPlayers.push(targetLeague.currentActivePlayer);
        if (Array.isArray(targetLeague.lotteryQueue)) allPlayers.push(...targetLeague.lotteryQueue);

        // 2. Permanently delete player image files from Firebase Cloud Storage
        await deletePlayersFromFirebaseStorage(allPlayers);

        // 3. Reset all players, queues, bids, sales from target league
        targetLeague.playersSnapshot = {};
        targetLeague.lotteryQueue = []; 
        targetLeague.unsoldPlayers = {}; 
        targetLeague.activeBids = {}; 
        targetLeague.activeBidders = {}; 
        targetLeague.previousOwners = {}; 
        targetLeague.soldPrices = {}; 
        targetLeague.directSigns = {}; 
        targetLeague.rtmEvents = {}; 
        targetLeague.rtmImpactLocks = {}; 
        targetLeague.rtmState = null; 
        targetLeague.currentActivePlayer = null;
        targetLeague.pickedPlayerCode = null;
        targetLeague.biddingActive = false; 
        targetLeague.codeShuffleActive = false;

        // 4. Reset franchise purses and clear all roster purchases
        if (targetLeague.teams && Array.isArray(targetLeague.teams)) {
            targetLeague.teams.forEach(t => { 
                t.purse = 500; 
                t.purchases = {}; 
                t.impactUsed = false; 
                t.impactActive = false; 
                t.directSignUsed = false; 
                t.rtmUsed = false; 
            });
        }

        // 5. Also sync default STATE if admin
        if (hostId === 'admin') {
            STATE.playersSnapshot = {};
            STATE.lotteryQueue = [];
            STATE.unsoldPlayers = {};
            STATE.currentActivePlayer = null;
            STATE.pickedPlayerCode = null;
            STATE.activeBids = {};
            STATE.activeBidders = {};
            STATE.previousOwners = {};
            STATE.soldPrices = {};
            STATE.directSigns = {};
            STATE.rtmEvents = {};
            STATE.rtmImpactLocks = {};
            STATE.rtmState = null;
            STATE.biddingActive = false;
            STATE.codeShuffleActive = false;
            if (STATE.teams && Array.isArray(STATE.teams)) {
                STATE.teams.forEach(t => { 
                    t.purse = 500; 
                    t.purchases = {}; 
                    t.impactUsed = false; 
                    t.impactActive = false; 
                    t.directSignUsed = false; 
                    t.rtmUsed = false; 
                });
            }
        }

        // 6. Delete standalone player documents from Firestore if collection exists
        if (db) {
            try {
                const playersCol = db.collection('players');
                const snap = await playersCol.get();
                if (!snap.empty) {
                    const batch = db.batch();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    console.log(`[Firestore] Master Reset: Deleted ${snap.docs.length} standalone player documents`);
                }
            } catch (e) {
                console.warn("[Firestore] Standalone players collection note:", e.message);
            }
        }

        TIMER_STATE = { paused: false, time: 30 };
        clearInterval(serverTimerInterval);

        const canonicalHost = (hostId || 'admin').toLowerCase();
        io.to(`host:${canonicalHost}`).emit('popup:close');
        io.to(`host:${canonicalHost}`).emit('timer:sync', TIMER_STATE);
        io.to(`host:${canonicalHost}`).emit('rtm:cleared');
        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${canonicalHost}`).emit('admin:toast', { msg: `🚨 Master Reset: All players deleted from database & Firebase Storage` });

        await immediateSaveToFirebase(); 
    });

    socket.on('admin:clear_all_players', async () => {
        if (socket.data.role !== 'admin') return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const canonicalHost = (hostId || 'admin').toLowerCase();

        // 1. Gather all players to permanently purge from Firebase Storage
        const allPlayers = [];
        if (targetLeague.playersSnapshot) {
            Object.values(targetLeague.playersSnapshot).forEach(list => {
                if (Array.isArray(list)) allPlayers.push(...list);
            });
        }
        if (targetLeague.currentActivePlayer) allPlayers.push(targetLeague.currentActivePlayer);
        if (Array.isArray(targetLeague.lotteryQueue)) allPlayers.push(...targetLeague.lotteryQueue);

        // 2. Permanently delete player image files from Firebase Cloud Storage
        await deletePlayersFromFirebaseStorage(allPlayers);

        // 3. Purge all players, queues, bids, sales from target league
        targetLeague.playersSnapshot = {};
        targetLeague.lotteryQueue = [];
        targetLeague.unsoldPlayers = {};
        targetLeague.currentActivePlayer = null;
        targetLeague.pickedPlayerCode = null;
        targetLeague.activeBids = {};
        targetLeague.activeBidders = {};
        targetLeague.soldPrices = {};
        targetLeague.previousOwners = {};
        targetLeague.directSigns = {};
        targetLeague.rtmEvents = {};
        targetLeague.rtmImpactLocks = {};
        targetLeague.rtmState = null;
        targetLeague.biddingActive = false;
        targetLeague.codeShuffleActive = false;

        // 4. Remove all player purchases from team rosters
        if (targetLeague.teams && Array.isArray(targetLeague.teams)) {
            targetLeague.teams.forEach(t => {
                t.purchases = {};
            });
        }

        // 5. Also sync default STATE if admin
        if (canonicalHost === 'admin') {
            STATE.playersSnapshot = {};
            STATE.lotteryQueue = [];
            STATE.unsoldPlayers = {};
            STATE.currentActivePlayer = null;
            STATE.pickedPlayerCode = null;
            STATE.activeBids = {};
            STATE.activeBidders = {};
            STATE.soldPrices = {};
            STATE.previousOwners = {};
            STATE.directSigns = {};
            STATE.rtmEvents = {};
            STATE.rtmImpactLocks = {};
            STATE.rtmState = null;
            STATE.biddingActive = false;
            STATE.codeShuffleActive = false;
            if (STATE.teams && Array.isArray(STATE.teams)) {
                STATE.teams.forEach(t => {
                    t.purchases = {};
                });
            }
        }

        // 6. Delete standalone player documents from Firestore if collection exists
        if (db) {
            try {
                const playersCol = db.collection('players');
                const snap = await playersCol.get();
                if (!snap.empty) {
                    const batch = db.batch();
                    snap.docs.forEach(doc => batch.delete(doc.ref));
                    await batch.commit();
                    console.log(`[Firestore] Deleted ${snap.docs.length} standalone player documents`);
                }
            } catch (e) {
                console.warn("[Firestore] Standalone players collection note:", e.message);
            }
        }

        io.to(`host:${canonicalHost}`).emit('popup:close');
        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${canonicalHost}`).emit('admin:toast', { msg: `🗑️ All players permanently deleted (including Firebase Storage)` });
        await immediateSaveToFirebase();
    });

    socket.on('admin:deletePlayer', async ({ category, name }) => {
        if (socket.data.role !== 'admin') return;
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const canonicalHost = (hostId || 'admin').toLowerCase();
        
        let deletedPlayer = null;
        if (targetLeague.playersSnapshot && Array.isArray(targetLeague.playersSnapshot[category])) {
            const idx = targetLeague.playersSnapshot[category].findIndex(p => p.name === name);
            if (idx !== -1) {
                [deletedPlayer] = targetLeague.playersSnapshot[category].splice(idx, 1);
            }
        }

        if (deletedPlayer) {
            await deletePlayersFromFirebaseStorage([deletedPlayer]);
        }

        const key = `${category}:${name}`;
        if (targetLeague.soldPrices) delete targetLeague.soldPrices[key];
        if (targetLeague.activeBids) delete targetLeague.activeBids[key];
        if (targetLeague.activeBidders) delete targetLeague.activeBidders[key];
        if (targetLeague.previousOwners) delete targetLeague.previousOwners[key];
        if (targetLeague.directSigns) delete targetLeague.directSigns[key];
        if (targetLeague.rtmEvents) delete targetLeague.rtmEvents[key];
        if (targetLeague.unsoldPlayers) delete targetLeague.unsoldPlayers[key];
        if (targetLeague.rtmImpactLocks) delete targetLeague.rtmImpactLocks[key];
        targetLeague.lotteryQueue = (targetLeague.lotteryQueue || []).filter(p => !(p.category === category && p.name === name));
        if (targetLeague.currentActivePlayer && targetLeague.currentActivePlayer.name === name) {
            targetLeague.currentActivePlayer = null;
            io.to(`host:${canonicalHost}`).emit('popup:close');
        }

        // Remove from team purchases
        (targetLeague.teams || []).forEach(t => {
            if (t.purchases && t.purchases[category] === name) {
                delete t.purchases[category];
            }
        });

        if (canonicalHost === 'admin') {
            if (STATE.playersSnapshot && Array.isArray(STATE.playersSnapshot[category])) {
                STATE.playersSnapshot[category] = STATE.playersSnapshot[category].filter(p => p.name !== name);
            }
            if (STATE.soldPrices) delete STATE.soldPrices[key];
            if (STATE.activeBids) delete STATE.activeBids[key];
            if (STATE.activeBidders) delete STATE.activeBidders[key];
            (STATE.teams || []).forEach(t => {
                if (t.purchases && t.purchases[category] === name) {
                    delete t.purchases[category];
                }
            });
        }

        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${canonicalHost}`).emit('admin:toast', { msg: `🗑️ Player "${name}" deleted from database & storage` });
        await immediateSaveToFirebase();
    });

    socket.on('schedule:save', async (scheduleData) => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const canonicalHost = (hostId || 'admin').toLowerCase();
        targetLeague.schedule = scheduleData || { teamNumbers: {}, matches: [] };
        if (canonicalHost === 'admin') {
            STATE.schedule = targetLeague.schedule;
        }
        io.to(`host:${canonicalHost}`).emit('schedule:updated', targetLeague.schedule);
        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${canonicalHost}`).emit('admin:toast', { msg: 'Tournament schedule updated & published!' });
        await immediateSaveToFirebase();
    });

    socket.on('schedule:reset', async () => {
        const hostId = socket.data.hostId || 'admin';
        const targetLeague = getLeague(hostId);
        const canonicalHost = (hostId || 'admin').toLowerCase();
        targetLeague.schedule = { teamNumbers: {}, matches: [] };
        if (canonicalHost === 'admin') {
            STATE.schedule = targetLeague.schedule;
        }
        io.to(`host:${canonicalHost}`).emit('schedule:updated', targetLeague.schedule);
        broadcastLeagueUpdate(hostId, targetLeague);
        io.to(`host:${canonicalHost}`).emit('admin:toast', { msg: 'Tournament schedule reset' });
        await immediateSaveToFirebase();
    });
});

loadFromFirebase().then(() => { server.listen(PORT, () => console.log(`Running on ${PORT}`)); });

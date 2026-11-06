const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { chromium } = require('playwright');
const dataFile = path.join(os.tmpdir(), `auction-test-${process.pid}.json`);
const url = 'http://127.0.0.1:3107';
let server, browser;
const clients=[];
function event(client,name){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Timed out: '+name)),8000);client.once(name,d=>{clearTimeout(timer);resolve(d);});});}
async function connect(){const client=io(url,{transports:['websocket'],forceNew:true});clients.push(client);await event(client,'connect');return client;}
async function start(){server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:'3107',AUCTION_DATA_FILE:dataFile,FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_PROJECT_ID:'',GOOGLE_APPLICATION_CREDENTIALS:''},stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{if(chunk.toString().includes('Running on'))resolve();});server.on('exit',code=>reject(new Error('Server exit '+code)));});}
async function stop(){if(server){const done=once(server,'exit');server.kill();await done;server=null;}}
(async()=>{
 await start();
 assert.equal((await fetch(url+'/auction-data.local.json')).status,404);
 assert.equal((await fetch(url+'/server.js')).status,404);
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(url);await page.waitForSelector('.room-empty');
 await page.getByRole('button',{name:'+ Create auction room',exact:true}).click();
 await page.locator('#roomName').fill('Test Premier League');await page.locator('#roomAdminPassword').fill('admin-test-2026');await page.locator('#roomViewerPassword').fill('viewer-test-2026');
 await page.getByRole('button',{name:'Create room & set up tournament'}).click();await page.waitForSelector('#appContainer:not(.hidden)');
 const session=await page.evaluate(()=>JSON.parse(localStorage.getItem('auctioncmd.session.v1')));const id=session.username;assert.match(id,/^ROOM-/);
 const admin=await connect();let pending=event(admin,'manager:logged_in');admin.emit('manager:login',{username:id,password:'admin-test-2026'});const auth=await pending;assert.deepEqual(auth.state.playersSnapshot,{});assert.equal(auth.state.room.viewerPassword,undefined);
 pending=event(admin,'state:updated');admin.emit('admin:updateConfig',{teams:[{id:'TIGERS',name:'Dhaka Tigers',password:'team-test-2026',purse:500},{id:'KINGS',name:'Sylhet Kings',password:'second-team-2026',purse:500}]});await pending;
 const team=await connect();pending=event(team,'auth:team_error');team.emit('team:login',{hostId:id,role:'admin',password:'admin-test-2026'});await pending;
 pending=event(team,'auth:team_error');team.emit('team:login',{hostId:id,role:'team',teamId:'TIGERS',password:'wrong'});await pending;
 const teamPage=await browser.newPage();await teamPage.goto(url);await teamPage.getByRole('heading',{name:'Test Premier League'}).click();await teamPage.locator('[data-login-role="team"]').click();await teamPage.locator('#participantConnectBtn').click();await teamPage.locator('#loginTeamId').selectOption('TIGERS');await teamPage.locator('#loginPass').fill('team-test-2026');await teamPage.getByRole('button',{name:'Enter auction room'}).click();await teamPage.waitForSelector('#appContainer:not(.hidden)');
 await teamPage.evaluate(()=>showSection('sectionPlayerDatabase'));await teamPage.locator('#submitNames').fill('Player One\nPlayer Two\nPlayer One');pending=event(admin,'state:updated');await teamPage.getByRole('button',{name:'Submit players',exact:true}).click();let state=await pending;assert.equal(state.playersSnapshot.CAT_BAT.length,2);
 const viewer=await connect();pending=event(viewer,'auth:team_error');viewer.emit('team:login',{hostId:id,role:'listener',password:'wrong'});await pending;
 pending=event(viewer,'auction:enter');viewer.emit('team:login',{hostId:id,role:'listener',password:'viewer-test-2026'});const access=await pending;assert.equal(access.state.teams[0].password,undefined);assert.equal(access.state.room.viewerPassword,undefined);
 pending=event(viewer,'auth:team_error');viewer.emit('admin:updateConfig',{teams:[]});await pending;
 // Live actions stay inside the selected room.
 const outsider=await connect();let leaked=false;outsider.on('popup:open',()=>leaked=true);outsider.on('state:updated',()=>leaked=true);
 pending=event(team,'auction:enter');team.emit('team:login',{hostId:id,role:'team',teamId:'TIGERS',password:'team-test-2026'});await pending;
 pending=event(viewer,'popup:open');admin.emit('admin:select_player',{category:'CAT_BAT',name:'Player One',base:50,currentPrice:50});assert.equal((await pending).name,'Player One');
 pending=event(team,'bidding:started');admin.emit('admin:start_bidding');await pending;
 pending=event(viewer,'player:bid');team.emit('player:bid',{category:'CAT_BAT',name:'Player One',price:60,teamId:'TIGERS'});assert.equal((await pending).price,60);
 pending=event(viewer,'player:sold');admin.emit('player:sold',{category:'CAT_BAT',name:'Player One',price:60,teamId:'TIGERS'});const sale=await pending;assert.equal(sale.teams[0].password,undefined);assert.equal(leaked,false);
 // Viewer UI and responsive lobby.
 const viewerPage=await browser.newPage({viewport:{width:390,height:844}});await viewerPage.goto(url);await viewerPage.waitForSelector('.room-tile');assert.equal(await viewerPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await viewerPage.getByRole('heading',{name:'Test Premier League'}).click();await viewerPage.locator('[data-login-role="listener"]').click();await viewerPage.locator('#participantConnectBtn').click();await viewerPage.waitForSelector('#teamAuthOverlay:not(.hidden)');assert.equal(await viewerPage.locator('#passGroup').isVisible(),true);await viewerPage.locator('#loginPass').fill('viewer-test-2026');await viewerPage.getByRole('button',{name:'Enter auction room'}).click();await viewerPage.waitForSelector('#appContainer:not(.hidden)');
 await page.reload();await page.waitForSelector('#appContainer:not(.hidden)');assert.deepEqual(errors,[]);
 for(const c of clients)c.disconnect();await stop();await start();const restored=await connect();pending=event(restored,'manager:logged_in');restored.emit('manager:login',{username:id,password:'admin-test-2026'});state=(await pending).state;assert.equal(state.teams.length,2);assert.equal(state.playersSnapshot.CAT_BAT.length,2);
 console.log('PASS: room creation, admin restore, team setup, wrong passwords, invalid roles, team database deduplication, viewer entry, secret redaction, authorization, mobile layout, room-scoped live selection, bidding, sale, and restart persistence.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{for(const c of clients)c.disconnect();if(browser)await browser.close();await stop();if(fs.existsSync(dataFile))fs.unlinkSync(dataFile);});

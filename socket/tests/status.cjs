const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
const url = 'http://127.0.0.1:3108';
const dataFile = path.join(os.tmpdir(), `auction-status-${process.pid}.json`);
let server, browser;
async function start() {
 server = spawn(process.execPath, ['server.js'], {cwd:path.join(__dirname,'..'), env:{...process.env,PORT:'3108',RENDER:'true',AUCTION_DATA_FILE:dataFile,FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_PROJECT_ID:'',GOOGLE_APPLICATION_CREDENTIALS:''},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{server.stdout.on('data',data=>{if(data.toString().includes('Running on'))resolve();});server.on('exit',code=>reject(new Error('Server exit '+code)));});
}
async function stop(){if(server){const done=once(server,'exit');server.kill();await done;server=null;}}
(async()=>{
 await start();browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(url);await page.waitForSelector('#connectionPanel[data-state="connected"]');
 await page.waitForFunction(()=>document.getElementById('latencyValue').textContent.endsWith(' ms'));
 await page.waitForFunction(()=>document.getElementById('healthValue').textContent==='Healthy');
 assert.equal(await page.locator('#transportValue').textContent(),'websocket');assert.equal(await page.locator('#storageMode').textContent(),'Local file');
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.waitForSelector('#connectionPanel[data-state="disconnected"]');assert.equal(await page.locator('#latencyValue').textContent(),'\u2014');
 await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.waitForSelector('#connectionPanel[data-state="connected"]');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:path.join(__dirname,'../../preview/backend-status.png'),fullPage:true});
 await stop();await page.waitForFunction(()=>document.getElementById('connectionPanel').dataset.state!=='connected');
 await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.waitForFunction(()=>document.getElementById('healthValue').textContent==='Unavailable');
 await start();await page.getByRole('button',{name:'Reconnect',exact:true}).click();await page.waitForSelector('#connectionPanel[data-state="connected"]');
 await page.goto(url+'/status');await page.waitForSelector('#connectionPanel[data-state="connected"]');
 await page.goto(url+'/index.html');await page.waitForSelector('#recommendedRooms button');
 assert.deepEqual(errors,[]);console.log('PASS: Render root status page, health, socket acknowledgement, disconnect/reconnect, outage recovery, mobile layout, /status route, and auction frontend route.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();await stop();if(fs.existsSync(dataFile))fs.unlinkSync(dataFile);});

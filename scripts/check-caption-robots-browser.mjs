import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
// Requires a Vite dev server and a dedicated Chrome remote-debugging instance.
// Convex hooks are replaced only in this browser target; no Mux jobs are created.
const base = process.env.ROBOTUBE_WEB_URL || 'http://localhost:5175';
const debug = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9224';
const mainSource = await (await fetch(base + '/src/main.tsx')).text();
const reactPath = mainSource.match(/from "([^"]*\/react\.js[^\"]*)"/)[1];
const clientPath = mainSource.match(/from "([^"]*\/react-dom_client\.js[^\"]*)"/)[1];
const page = await (await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve));
let id = 0; const pending = new Map(); const exceptions = [];
const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({id:n,method,params})); });
const fixture = {
 trackId:'track-source', captionRevision:2, cues:[
  {id:'one',startMs:0,endMs:2000,text:'[speaker_0] Mucks and Mucks.'},
  {id:'two',startMs:2000,endMs:4000,text:'[speaker_1] Mucks is here.'},
  {id:'three',startMs:4000,endMs:6000,text:'[speaker_0] Another sentence.'},
 ]
};
const mock = `import React from '${reactPath}';
const state={canEdit:true,captionRevision:2,sourceTrack:{id:'track-source',name:'English',languageCode:'en',status:'ready'}};
const store=window.__captionTest={state,document:${JSON.stringify(fixture)},calls:[],mode:'error',closed:false,listeners:new Set()};
store.update=(patch)=>{Object.assign(store,patch);for(const f of store.listeners)f();};
const actions={loadOwnCaptionDocument:async()=>structuredClone(store.document),editCaptionsForAsset:async(args)=>{
 store.calls.push(structuredClone(args)); await new Promise(r=>setTimeout(r,50));
 if(store.mode==='error')throw new Error('Simulated request failure');
 if(store.mode==='active')return {alreadyActive:true,jobId:'robot-existing',status:'processing'};
 store.update({state:{...store.state,canEdit:false,unavailableReason:'Caption edits are already being applied.',latestJob:{status:'processing',jobId:'robot-new'}}});
 return {alreadyActive:false,jobId:'robot-new',status:'pending'};
}};
export const useAction=(name)=>actions[name]??(async()=>({}));
export const useConvexAuth=()=>({isAuthenticated:true,isLoading:false});
const subscribe=(f)=>{store.listeners.add(f);return()=>store.listeners.delete(f)};
export const useQuery=()=>React.useSyncExternalStore(subscribe,()=>store.state);`;
const apiMock = `export const api={captionEditing:{getOwnCaptionEditorState:'state'},captionEditingNode:new Proxy({}, {get:(_,name)=>name})};`;
ws.addEventListener('message', async event => {
 const data=JSON.parse(event.data);
 if(data.id){pending.get(data.id)?.(data);pending.delete(data.id);}
 if(data.method==='Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails);
 if(data.method==='Fetch.requestPaused') {
   const {requestId,request}=data.params; const url=new URL(request.url); let text;
   if(url.pathname==='/src/main.tsx') text=`import React from '${reactPath}';import client from '${clientPath}';import {CaptionCleanup} from '/src/components/CaptionCleanup.tsx';import '/src/styles.css';client.createRoot(document.getElementById('root')).render(React.createElement(CaptionCleanup,{open:true,muxAssetId:'asset-1',title:'Robots test',onClose:()=>{window.__captionTest.closed=true}}));`;
   else if(url.pathname==='/src/lib/convex.ts') text=apiMock;
   else if(url.pathname==='/__caption-mock.js') text=mock;
   else if(url.pathname==='/src/components/CaptionCleanup.tsx') {
     text=await (await fetch(request.url)).text();
     text=text.replace(/from "[^\"]*\/convex_react\.js[^\"]*"/, 'from "/__caption-mock.js"');
   }
   if(text!==undefined)await send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript'}],body:Buffer.from(text).toString('base64')});
   else await send('Fetch.continueRequest',{requestId});
 }
});
await send('Runtime.enable');await send('Page.enable');
await send('Fetch.enable',{patterns:['*/src/main.tsx*','*/src/lib/convex.ts*','*/src/components/CaptionCleanup.tsx*','*/__caption-mock.js*'].map(urlPattern=>({urlPattern,requestStage:'Request'}))});
const evaluate=async(expression)=>{
 const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(result.result.exceptionDetails)throw new Error(JSON.stringify(result.result.exceptionDetails));
 return result.result.result.value;
};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
await send('Page.navigate',{url:base+'/__caption-browser-test'});await pause(3000);
if(exceptions.length) console.log(JSON.stringify(exceptions));
assert.equal(await evaluate('!!document.querySelector("dialog[open]")'),true);
assert.equal(await evaluate('document.querySelectorAll(".caption-cue").length'),3);
assert.equal(await evaluate('document.querySelectorAll(".caption-cue textarea").length'),0);
for (const viewport of [{width:1280,height:800,mobile:false},{width:390,height:844,mobile:true}]) {
 await send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1});await pause(100);
 await evaluate('document.querySelector(".caption-dialog__body").scrollTop=0');
 assert.equal(await evaluate(`(()=>{
   const body=document.querySelector('.caption-dialog__body').getBoundingClientRect();
   const cleanup=document.querySelector('.caption-switch').getBoundingClientRect();
   const transcript=document.querySelector('[aria-label="Caption transcript"]').getBoundingClientRect();
   return cleanup.top>=body.top && cleanup.bottom<=body.bottom && cleanup.bottom<transcript.top;
 })()`),true,`AI cleanup must be visible before the transcript without scrolling at ${viewport.width}px`);
 await evaluate('document.querySelector("input[role=switch]").click()');await pause(50);
 assert.equal(await evaluate(`(()=>{
   const body=document.querySelector('.caption-dialog__body').getBoundingClientRect();
   const mode=document.querySelector('.caption-switch').closest('fieldset').querySelector('select').getBoundingClientRect();
   return mode.top>=body.top && mode.bottom<=body.bottom;
 })()`),true,`Profanity mode must be visible without scrolling at ${viewport.width}px`);
 await evaluate('document.querySelector("input[role=switch]").click()');await pause(50);
}
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await pause(100);
assert.equal(await evaluate(`(()=>{const heading=[...document.querySelectorAll('legend')].find(e=>e.textContent==='Speaker names');return !!heading && heading.getBoundingClientRect().top<document.querySelector('[aria-label="Caption transcript"]').getBoundingClientRect().top;})()`),true,'Speaker names is discoverable before the transcript');
await evaluate(`(()=>{const p=document.querySelector('.caption-cue__text');const text=p.firstChild;const index=text.textContent.indexOf('Mucks');const range=document.createRange();range.setStart(text,index);range.setEnd(text,index+5);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
await pause(50);
assert.equal(await evaluate('[...document.querySelectorAll("label")].find(label => label.textContent.includes("Selected word or phrase")).querySelector("input").value'),'Mucks');
async function input(label, value) {
 await evaluate(`(()=>{const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)}));const input=label.querySelector('input,select');const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await pause(40);
}
async function click(text){await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Button missing '+${JSON.stringify(text)});b.click()})()`);await pause(80)}
await input('Replace everywhere with','Mux');await click('Queue correction');
assert.equal(await evaluate('document.querySelectorAll(".caption-cue__preview").length'),2);
assert.equal(await evaluate('document.body.textContent.includes("2 affected cues, 3 replacements")'),true);
await input('Transcript speaker','speaker_0');await input('New speaker name','Alice');await click('Queue speaker rename');
await evaluate('document.querySelector("input[role=switch]").click()');await pause(50);await input('Profanity mode','mask');
assert.equal(await evaluate('document.querySelector(".caption-cue__preview").textContent.includes("[Alice] Mux and Mux.")'),true);
await click('Apply caption edits');assert.equal(await evaluate('!!document.querySelector(".caption-confirm")'),true);
await click('Replace and apply edits');await pause(150);
assert.equal(await evaluate('window.__captionTest.calls.length'),1);
assert.equal(await evaluate('document.querySelectorAll(".caption-rules li").length'),2,'failed submissions retain both queued rules');
await evaluate("window.__captionTest.mode='active'");await click('Apply caption edits');await click('Replace and apply edits');await pause(150);
assert.equal(await evaluate('document.querySelectorAll(".caption-rules li").length'),2,'alreadyActive retains queued rules');
assert.equal(await evaluate('document.body.textContent.includes("Your draft was not submitted")'),true);
await evaluate("window.__captionTest.mode='success'");await click('Apply caption edits');
await evaluate(`(()=>{const b=document.querySelector('.caption-confirm .button--danger');b.click();b.click()})()`);await pause(150);
assert.equal(await evaluate('window.__captionTest.calls.length'),3,'synchronous guard prevents duplicate call');
const body=await evaluate('window.__captionTest.calls[2]');
assert.deepEqual(body,{muxAssetId:'asset-1',trackId:'track-source',captionRevision:2,replacements:[{find:'Mucks',replace:'Mux',caseSensitive:false}],speakerReplacements:[{find:'speaker_0',replace:'Alice'}],autoCensorProfanity:{mode:'mask'}});
assert.equal(await evaluate('document.body.textContent.includes("robot-new")'),true);
await evaluate(`(()=>{const s=window.__captionTest;s.document={...s.document,trackId:'track-reviewed',captionRevision:3,cues:s.document.cues.map(c=>({...c,text:c.text.replaceAll('Mucks','Mux').replace('[speaker_0]','[Alice]')}))};s.update({state:{...s.state,canEdit:true,captionRevision:3,sourceTrack:{...s.state.sourceTrack,id:'track-reviewed'},latestJob:{status:'completed',jobId:'robot-new',uploadedTrackId:'track-reviewed',totalReplacementCount:5,reconciliationStatus:'completed'}}});})()`);
await pause(150);
assert.equal(await evaluate('document.querySelectorAll(".caption-rules li").length'),0);
assert.equal(await evaluate('document.querySelector(".caption-cue__text").textContent'),'[Alice] Mux and Mux.');
assert.equal(await evaluate('document.body.textContent.includes("Actual replacements: 5")'),true);
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await pause(100);
assert.equal(await evaluate('document.querySelector("dialog").getBoundingClientRect().width <= innerWidth'),true);
if (process.env.ROBOTUBE_SCREENSHOT_PATH) await writeFile(process.env.ROBOTUBE_SCREENSHOT_PATH,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).result.data,'base64'));
await evaluate(`(()=>{const s=window.__captionTest;s.document={...s.document,trackId:'track-unlabeled',captionRevision:4,cues:s.document.cues.map(c=>({...c,text:c.text.replace(/^\\[[^\\]]+\\]\\s*/, '')}))};s.update({state:{...s.state,captionRevision:4,sourceTrack:{...s.state.sourceTrack,id:'track-unlabeled'},latestJob:undefined}});})()`);await pause(150);
assert.equal(await evaluate('document.body.textContent.includes("current caption track has no speaker labels")'),true);
assert.equal(await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="Queue speaker rename").disabled'),true);
assert.deepEqual(exceptions,[]);
console.log('PASS actual web component in Chrome: transcript selection, global preview, speaker rename, profanity, failure/draft retention, already-active response, double-submit guard, exact action payload, progress, refreshed transcript, narrow viewport. Backend actions mocked; no live Mux write.');
await send('Fetch.disable');ws.close();

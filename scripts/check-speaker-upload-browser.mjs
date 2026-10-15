import assert from "node:assert/strict";

const base = process.env.ROBOTUBE_WEB_URL || "http://localhost:5177";
const debug = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9224";
const main = await (await fetch(`${base}/src/main.tsx`)).text();
const dependency = (name) => main.match(new RegExp(`from "([^"]*/${name}\\.js[^\"]*)"`))?.[1];
const react = dependency("react"), client = dependency("react-dom_client"), router = dependency("react-router-dom");
assert.ok(react && client && router, "Start the web Vite server before running this check");
const target = await (await fetch(`${debug}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 0, failPut = false;
const pending = new Map(), exceptions = [], unexpectedRequests = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15_000);
  pending.set(id, (value) => { clearTimeout(timeout); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value); });
  ws.send(JSON.stringify({ id, method, params }));
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mock = `
const store=window.__speakerUpload={calls:[],mode:'error'};
const pipeline={done:false,progress:100,statusText:'Private upload ready for review',passed:true,jobs:[]};
const create=async(args)=>{store.calls.push(structuredClone(args));await new Promise(r=>setTimeout(r,150));if(store.mode==='error')throw new Error('Simulated configuration error');return{uploadId:'test-upload',uploadUrl:'${base}/__speaker-upload'};};
export const useAction=(name)=>name==='uploads:createMuxDirectUpload'?create:async()=>({});
export const useMutation=()=>async()=>({});
export const useConvexAuth=()=>({isAuthenticated:true,isLoading:false});
export const useAuthActions=()=>({signIn:async()=>{},signOut:async()=>{}});
export const useQuery=(name,args)=>args==='skip'?undefined:name==='uploadStatus:getUploadPipelineStatus'?pipeline:null;
export const usePaginatedQuery=()=>({results:[],status:'Exhausted',loadMore:()=>{}});
`;
ws.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data);
  if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
  if (message.method !== "Fetch.requestPaused") return;
  const { requestId, request } = message.params;
  try {
    const url = new URL(request.url);
    if (url.hostname.endsWith("convex.cloud") || url.hostname === "api.mux.com") {
      unexpectedRequests.push(request.url);
      await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      return;
    }
    let body, contentType = "text/javascript", status = 200;
    if (url.pathname === "/src/main.tsx") {
      body = `import React from '${react}';import client from '${client}';import {BrowserRouter} from '${router}';import {App} from '/src/App.tsx';import '/src/styles.css';client.createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(App)));`;
    } else if (url.pathname === "/src/lib/convex.ts") {
      body = `export const api=new Proxy({}, {get:(_,module)=>new Proxy({}, {get:(_,name)=>module+':'+name})});`;
    } else if (url.pathname === "/__speaker-hooks.js") body = mock;
    else if (url.pathname === "/__speaker-upload") { body = ""; contentType = "text/plain"; status = failPut ? 503 : 200; }
    else if (url.pathname.endsWith(".tsx")) {
      body = await (await fetch(request.url)).text();
      body = body.replace(/from "[^"]*\/(?:convex_react|@convex-dev_auth_react)\.js[^"]*"/g, 'from "/__speaker-hooks.js"');
    }
    if (body !== undefined) await send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "Content-Type", value: contentType }], body: Buffer.from(body).toString("base64") });
    else await send("Fetch.continueRequest", { requestId });
  } catch (error) {
    exceptions.push(String(error));
    await send("Fetch.failRequest", { requestId, errorReason: "Failed" });
  }
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result.result.value;
};
const checkbox = 'document.querySelector(".speaker-upload-option input")';
async function fillVideo(name = "fixture.mp4") {
  await evaluate(`(()=>{const input=document.querySelector('input[type=file][accept^="video"]');const data=new DataTransfer();data.items.add(new File(['fixture'],${JSON.stringify(name)},{type:'video/mp4'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));const title=document.querySelector('.upload-form .field input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,'Test upload');title.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await pause(60);
}
async function click(text) {
  await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing button: '+${JSON.stringify(text)});button.click();})()`);
  await pause(60);
}
try {
  await send("Runtime.enable"); await send("Page.enable");
  await send("Fetch.enable", { patterns: ["*/src/*.tsx*", "*/src/lib/convex.ts*", "*/__speaker-hooks.js*", "*/__speaker-upload*", "*convex.cloud*", "*api.mux.com*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${base}/upload` }); await pause(2500);
  assert.deepEqual(exceptions, []);
  await evaluate('sessionStorage.removeItem("robotube-upload-include-speakers")');
  await send("Page.reload"); await pause(1800);
  assert.equal(await evaluate(`${checkbox}.checked`), false, "new upload defaults off");
  await fillVideo(); await click("Upload video");
  assert.equal(await evaluate(`${checkbox}.disabled`), true, "option locks during submission");
  await pause(220);
  assert.equal(await evaluate("window.__speakerUpload.calls[0].includeSpeakers"), false);
  await evaluate(`${checkbox}.click()`); await pause(50);
  await fillVideo("replacement.mp4");
  assert.equal(await evaluate(`${checkbox}.checked`), true, "file replacement retains choice");
  await evaluate("history.pushState({},'', '/');dispatchEvent(new PopStateEvent('popstate'))"); await pause(100);
  await evaluate("history.pushState({},'', '/upload');dispatchEvent(new PopStateEvent('popstate'))"); await pause(100);
  assert.equal(await evaluate(`${checkbox}.checked`), true, "route navigation retains choice");
  await fillVideo();
  await click("Upload video"); await pause(220);
  assert.equal(await evaluate("window.__speakerUpload.calls.at(-1).includeSpeakers"), true);
  assert.equal(await evaluate(`${checkbox}.checked`), true, "action failure retains choice");
  await evaluate("window.__speakerUpload.mode='success'"); failPut = true;
  await click("Upload video"); await pause(350);
  assert.equal(await evaluate(`${checkbox}.checked`), true, "transfer failure retains choice");
  assert.equal(await evaluate(`${checkbox}.disabled`), true, "issued upload freezes the requested setting");
  failPut = false;
  await click("Upload video"); await pause(350);
  assert.equal(await evaluate("window.__speakerUpload.calls.at(-1).includeSpeakers"), true, "retry keeps requested value");
  assert.equal(await evaluate('document.body.textContent.includes("Speaker labels requested: On")'), true);
  await click("Upload another video");
  assert.equal(await evaluate(`${checkbox}.checked`), false, "another upload resets off");
  assert.equal(await evaluate(`${checkbox}.disabled`), false);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await pause(100);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "mobile-width layout does not overflow");
  assert.deepEqual(exceptions, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log("PASS actual web upload UI: default/off/on payload, submission lock, file replacement, route navigation, action/transfer failures, retry, status summary, full reset, narrow viewport. Convex actions and file transfer mocked; no live uploads or Mux jobs.");
} finally {
  await send("Fetch.disable");
  await send("Page.close");
  ws.close();
}

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,method='GET',body){
  const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body&&JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||'Something went wrong');e.status=r.status;e.code=d.code;throw e}
  return d;
}
function toast(m){let t=$('#toast');if(!t){t=document.createElement('div');t.id='toast';t.setAttribute('role','status');document.body.append(t)}t.textContent=m;t.hidden=false;clearTimeout(t.t);t.t=setTimeout(()=>t.hidden=true,3200)}
function sheet(html,mid){closeSheet();const b=document.createElement('div');b.className='bg'+(mid?' mid':'');b.id='sheet';b.innerHTML=`<div class="sheet" role="dialog" aria-modal="true"><button class="back x" aria-label="Close" onclick="closeSheet()" style="padding:0 10px">${ic('x',22)}</button>${html}</div>`;b.onclick=e=>{if(e.target===b)closeSheet()};document.body.append(b)}
const closeSheet=()=>$('#sheet')?.remove();
const fmtPhone=p=>p?`+91 ${p.slice(0,5)} ${p.slice(5)}`:'';
const fmtDate=d=>d?new Date(d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'-';
const fmtTime=d=>d?new Date(d).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'-';
const daysLeft=d=>Math.max(0,Math.ceil((new Date(d)-Date.now())/864e5));
/* one stamp impression: double ring + shop glyph, slightly rotated and offset like a real hand stamp */
function stampImg(name,i=0){
  const r=((i*53)%17)-8,dx=(((i*29)%7)-3)*.7,dy=(((i*41)%7)-3)*.7,o=(.86+((i*13)%10)/70).toFixed(2);
  return `<span class="stampimg" style="--r:${r}deg;--dx:${dx}%;--dy:${dy}%;--o:${o}"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="50" cy="50" r="39" fill="none" stroke="currentColor" stroke-width="1.4"/><svg x="26" y="26" width="48" height="48" viewBox="0 0 256 256" fill="currentColor">${STAMP[name]||STAMP.star}</svg></svg></span>`;
}
/* ---- storage that never throws (private mode, blocked site data): the app works without it, just slower ---- */
const store={get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}},del(k){try{localStorage.removeItem(k)}catch{}}};
const loadScript=src=>loadScript[src]||(loadScript[src]=new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>{delete loadScript[src];s.remove();no(new Error('Could not load. Check your internet and try again.'))};document.head.append(s)}));
/* ---- confirm in our own sheet instead of the browser's confirm() box. Resolves true/false ---- */
function ask(title,body,ok='Confirm',danger){return new Promise(res=>{
  sheet(`<h2 style="margin:0 0 10px">${esc(title)}</h2>${body?`<p class="mu" style="margin-bottom:18px">${esc(body)}</p>`:''}<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ${danger?'red':''}" id="askok">${esc(ok)}</button><button class="btn line" id="askno">Cancel</button></div>`,1);
  const done=v=>{closeSheet();res(v)};$('#askok').onclick=()=>done(true);$('#askno').onclick=()=>done(false);
  const bg=$('#sheet');bg.onclick=e=>{if(e.target===bg)done(false)};bg.querySelector('.x').onclick=()=>done(false);$('#askok').focus()})}
/* ---- QR drawing (vendored qrcode-generator, loaded only when a QR is shown) ---- */
async function qrSvg(text,px=240){await loadScript('/vendor/qrcode-generator-1.4.4.js');const q=qrcode(0,'M');q.addData(text);q.make();
  const n=q.getModuleCount(),m=2,c=n+m*2;let d='';for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(q.isDark(y,x))d+=`M${x+m} ${y+m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c} ${c}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${c}" height="${c}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`}
/* ---- camera QR scanner: the browser's own detector where it exists (Chrome/Android), jsQR everywhere else (iPhone) ---- */
async function scanCamera(onCode,onFail){
  const v=document.createElement('video');v.setAttribute('playsinline','');v.muted=true;v.style.cssText='position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:70;background:#000';
  const x=document.createElement('button');x.className='back';x.innerHTML=ic('x',22)+'<span>Close</span>';x.style.cssText='position:fixed;top:16px;left:16px;z-index:71';
  const tip=document.createElement('div');tip.textContent='Point the camera at the QR code';tip.style.cssText='position:fixed;bottom:28px;left:16px;right:16px;z-index:71;text-align:center;color:#fff;font-weight:700;text-shadow:0 1px 3px #000';
  document.body.append(v,x,tip);let st,on=true;const stop=()=>{on=false;st?.getTracks().forEach(t=>t.stop());v.remove();x.remove();tip.remove()};x.onclick=stop;
  try{
    st=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});v.srcObject=st;await v.play();
    let detect;
    if('BarcodeDetector' in window){const d=new BarcodeDetector({formats:['qr_code']});detect=async()=>(await d.detect(v))[0]?.rawValue}
    else{await loadScript('/vendor/jsqr-1.4.0.js');const c=document.createElement('canvas'),g=c.getContext('2d',{willReadFrequently:true});
      detect=async()=>{const w=Math.min(640,v.videoWidth),hh=Math.round(v.videoHeight*w/v.videoWidth);if(!w)return;c.width=w;c.height=hh;g.drawImage(v,0,0,w,hh);return jsQR(g.getImageData(0,0,w,hh).data,w,hh,{inversionAttempts:'dontInvert'})?.data}}
    let last=0;(async function tick(t){if(!on)return;if(t-last>150){last=t;try{const r=await detect();if(r){stop();return onCode(r)}}catch{}}requestAnimationFrame(tick)})(0);
  }catch{stop();onFail&&onFail()}
}

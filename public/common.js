const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,method='GET',body){
  const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body&&JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||'Something went wrong');e.status=r.status;e.code=d.code;throw e}
  return d;
}
function toast(m){let t=$('#toast');if(!t){t=document.createElement('div');t.id='toast';document.body.append(t)}t.textContent=m;t.hidden=false;clearTimeout(t.t);t.t=setTimeout(()=>t.hidden=true,3200)}
function sheet(html,mid){closeSheet();const b=document.createElement('div');b.className='bg'+(mid?' mid':'');b.id='sheet';b.innerHTML=`<div class="sheet" role="dialog" aria-modal="true"><button class="back x" aria-label="Close" onclick="closeSheet()" style="padding:0 10px">${ic('x',22)}</button>${html}</div>`;b.onclick=e=>{if(e.target===b)closeSheet()};document.body.append(b)}
const closeSheet=()=>$('#sheet')?.remove();
const fmtPhone=p=>p?`+91 ${p.slice(0,5)} ${p.slice(5)}`:'';
const fmtDate=d=>d?new Date(d).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'-';
const fmtTime=d=>d?new Date(d).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}):'-';
const daysLeft=d=>Math.max(0,Math.ceil((new Date(d)-Date.now())/864e5));
const FONTS='<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">';
document.head.insertAdjacentHTML('beforeend',FONTS);
/* rubber-stamp ink: rough edge + patchy ink, applied to every stamp impression */
document.body.insertAdjacentHTML('afterbegin','<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="ink" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="4" result="a"/><feDisplacementMap in="SourceGraphic" in2="a" scale="1.3" result="d"/><feTurbulence type="fractalNoise" baseFrequency=".11 .13" numOctaves="2" seed="9" result="b"/><feColorMatrix in="b" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 2.6 -.15" result="m"/><feComposite in="d" in2="m" operator="in"/></filter></svg>');
/* one stamp impression: double ring + shop glyph, slightly rotated and offset like a real hand stamp */
function stampImg(name,i=0){
  const r=((i*53)%17)-8,dx=(((i*29)%7)-3)*.7,dy=(((i*41)%7)-3)*.7,o=(.86+((i*13)%10)/70).toFixed(2);
  return `<span class="stampimg" style="--r:${r}deg;--dx:${dx}%;--dy:${dy}%;--o:${o}"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="50" cy="50" r="39" fill="none" stroke="currentColor" stroke-width="1.4"/><svg x="26" y="26" width="48" height="48" viewBox="0 0 256 256" fill="currentColor">${STAMP[name]||STAMP.star}</svg></svg></span>`;
}

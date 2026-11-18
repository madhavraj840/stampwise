/* Bunkwise admin. Hash routes: #p/<project>/dash | #p/<project>/e/<entity>[/<id>] | #p/<project>/system | #audit | #admins | #account
   No inline handlers (strict CSP): clicks are handled through data-act attributes. */
const $=s=>document.querySelector(s),app=$('#app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ME=null,PROJ=[],state={q:'',f:null,o:0};
const RANK={viewer:1,support:2,owner:3};
async function api(url,method='GET',body){
  const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'});
  const d=await r.json().catch(()=>({}));if(r.status===401&&url!=='/api/login'){ME=null;login();throw new Error('Please sign in')}if(!r.ok)throw new Error(d.error||'Request failed');return d;
}
const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('on'),3500)};
const fmt=(v,t='')=>{if(v==null||v==='')return '<span class="mu">–</span>';
  if(t==='date')return esc(new Date(v).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'2-digit'}));
  if(t==='time')return esc(new Date(v).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}));
  if(t==='tag')return `<span class="tag ${esc(v)}">${esc(v)}</span>`;if(t==='bool')return v?'Yes':'No';if(t==='mono')return `<span class="mono">${esc(v)}</span>`;
  if(typeof v==='boolean')return v?'Yes':'No';if(typeof v==='object')return `<span class="mono sm">${esc(JSON.stringify(v))}</span>`;return esc(v)};
const cell=(r,[k,,t=''])=>{if(t.startsWith('link:')){const[,e,idk]=t.split(':');return r[idk]?`<a href="#p/${cur().p}/e/${e}/${r[idk]}">${esc(r[k]??'–')}</a>`:fmt(r[k])}return fmt(r[k],t)};
const table=(cols,rows,link)=>rows.length?`<div class="tbl"><table><thead><tr>${cols.map(([,l,t])=>`<th class="${t==='num'?'num':''}" scope="col">${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr ${link?`class="click" data-go="${link(r)}" tabindex="0"`:''}>${cols.map(c=>`<td class="${c[2]==='num'?'num':''}">${cell(r,c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'<div class="tbl"><div class="empty">Nothing here</div></div>';
const cur=()=>{const[a,p,b,e,id]=location.hash.slice(1).split('/');return{a,p,b,e,id}};
const proj=k=>PROJ.find(p=>p.key===k);

/* ---------- login ---------- */
function login(){
  app.innerHTML=`<form class="login" id="lf"><h1>Bunkwise Admin</h1><label for="em">Email</label><input id="em" type="email" autocomplete="username" required>
  <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
  <label for="cd">Authenticator code</label><input id="cd" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required>
  <button class="btn pri">Sign in</button></form>`;
  $('#lf').onsubmit=async ev=>{ev.preventDefault();const b=ev.submitter;b.disabled=true;
    try{await api('/api/login','POST',{email:$('#em').value,password:$('#pw').value,code:$('#cd').value});await boot()}catch(e){toast(e.message);b.disabled=false}};
  $('#em').focus();
}

/* ---------- shell ---------- */
function shell(title,body,actions=''){
  const c=cur(),nav=(href,label)=>`<a href="#${href}" ${location.hash==='#'+href||location.hash.startsWith('#'+href+'/')?'aria-current="page"':''}>${esc(label)}</a>`;
  app.innerHTML=`<div class="shell"><nav class="side" id="side" aria-label="Main"><div class="brand">Bunkwise Admin</div>
    ${PROJ.map(p=>`<div class="grp">${esc(p.name)}</div>${nav(`p/${p.key}/dash`,'Dashboard')}${p.entities.map(e=>nav(`p/${p.key}/e/${e.key}`,e.label)).join('')}${ME.role==='owner'?nav(`p/${p.key}/system`,'System'):''}`).join('')}
    <div class="grp">Admin</div>${nav('audit','Audit log')}${ME.role==='owner'?nav('admins','Admin users'):''}${nav('account','My account')}
    <div class="me">${esc(ME.email)} · ${esc(ME.role)}<br><a href="#" data-act="logout">Sign out</a></div></nav>
    <main><div class="bar"><button class="btn menu" data-act="menu" aria-label="Menu">☰</button><h1 style="margin:0;flex:1">${title}</h1>${actions}</div>${body}</main></div>`;
}

/* ---------- dashboard ---------- */
function chart(rows,key){if(!rows.length)return '<p class="mu">No data yet</p>';const W=600,H=160,P=24,mx=Math.max(1,...rows.map(r=>r[key])),x=i=>P+i*(W-2*P)/Math.max(1,rows.length-1),y=v=>H-20-v*(H-40)/mx;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} per day, max ${mx}"><polyline fill="none" stroke="currentColor" stroke-width="2.5" points="${rows.map((r,i)=>x(i)+','+y(r[key])).join(' ')}"/><text x="${P}" y="14" font-size="11" fill="currentColor">max ${mx}</text><text x="${P}" y="${H-4}" font-size="11" fill="currentColor">${esc(new Date(rows[0].day).toLocaleDateString('en-IN',{day:'numeric',month:'short'}))}</text><text x="${W-P}" y="${H-4}" font-size="11" text-anchor="end" fill="currentColor">${esc(new Date(rows.at(-1).day).toLocaleDateString('en-IN',{day:'numeric',month:'short'}))}</text></svg>`}
async function dash(p,fresh){
  const s=await api(`/api/p/${p.key}/stats${fresh?'?fresh=1':''}`),t=s.totals,sum=k=>s.days.reduce((a,d)=>a+d[k],0);
  const k=[['Shops',t.shops],['Active (7 days)',t.active7],['Active (30 days)',t.active30],['Suspended',t.suspended],['Paused',t.paused],['Customers',t.customers],['Cards',t.cards],['Stamps (30 days)',sum('stamps')],['Rewards earned (30 d)',sum('earned')],['Redeemed (30 d)',sum('redeemed')]];
  shell(esc(p.name)+' · Dashboard',`${t.resets?`<div class="note">${t.resets} password reset${t.resets>1?'s':''} waiting. <a href="#p/${p.key}/e/resets">Review</a></div>`:''}
  <div class="kpis">${k.map(([l,v])=>`<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
  <div class="g2" style="margin-top:12px"><div class="card"><h2 style="margin-top:0">Stamps per day (30 days)</h2>${chart(s.days,'stamps')}</div><div class="card"><h2 style="margin-top:0">New customers per day</h2>${chart(s.days,'new_customers')}</div></div>
  <h2>Flags to check</h2>${table([['kind','Type','tag'],['label','Who'],['why','Why']],s.flags,r=>`p/${p.key}/e/${r.kind==='shop'?'shops':'customers'}/${r.id}`)}
  <h2>Top shops (30 days)</h2>${table([['name','Shop'],['stamps','Stamps','num'],['new_customers','New customers','num']],s.top,r=>`p/${p.key}/e/shops/${r.id}`)}
  <p class="sm mu">Numbers refresh at most once a minute.</p>`,`<button class="btn" data-act="fresh">Refresh</button>`);
}

/* ---------- lists ---------- */
async function list(p,e){
  if(state.key!==p.key+e.key)state={key:p.key+e.key,q:'',f:e.filters[0][0],o:0};
  const d=await api(`/api/p/${p.key}/e/${e.key}?q=${encodeURIComponent(state.q)}&f=${encodeURIComponent(state.f)}&o=${state.o}`);
  shell(esc(e.label),`<form class="bar" id="sf" role="search"><input type="search" id="sq" placeholder="Search" aria-label="Search ${esc(e.label)}" value="${esc(state.q)}"><button class="btn">Search</button>
    <div class="seg" role="group" aria-label="Filter">${e.filters.map(([v,l])=>`<button type="button" data-act="filter" data-v="${esc(v)}" aria-pressed="${state.f===v}">${esc(l)}</button>`).join('')}</div></form>
    ${table(e.cols,d.rows,r=>`p/${p.key}/e/${e.key}/${r.id}`)}
    <div class="bar" style="margin-top:10px"><button class="btn" data-act="page" data-v="-1" ${state.o?'':'disabled'}>Previous</button><span class="mu sm">Rows ${d.rows.length?state.o+1:0}–${state.o+d.rows.length}</span><button class="btn" data-act="page" data-v="1" ${d.more?'':'disabled'}>Next</button></div>`);
  $('#sf').onsubmit=ev=>{ev.preventDefault();state.q=$('#sq').value.trim();state.o=0;route()};
}

/* ---------- detail + actions ---------- */
async function detail(p,e,id){
  const d=await api(`/api/p/${p.key}/e/${e.key}/${id}`),acts=e.actions.filter(a=>!a.when||String(d.row[a.when[0]])===a.when[1]);
  shell(`<a href="#p/${p.key}/e/${e.key}" class="sm">${esc(e.label)}</a> / ${esc(d.title)}`,
    `<div class="card"><dl>${Object.entries(d.fields).map(([k,v])=>`<dt>${esc(k.replace(/_/g,' '))}</dt><dd>${fmt(v,/_at$/.test(k)?'time':k==='status'?'tag':'')}</dd>`).join('')}</dl></div>
    ${d.sections.map(s=>`<h2>${esc(s.title)}</h2>${table(s.cols,s.rows)}`).join('')}`,
    acts.map(a=>`<button class="btn ${a.danger?'dgr':''}" data-act="action" data-k="${a.key}">${esc(a.label)}</button>`).join(''));
  app._acts=acts;app._ctx={p,e,id,title:d.title};
}
function runAction(a){
  const{p,e,id,title}=app._ctx,dlg=$('#dlg');
  dlg.innerHTML=`<form method="dialog" id="af"><h3>${esc(a.label)}</h3><p class="mu">${esc(e.label)}: <b>${esc(title)}</b></p>
    ${a.input?`<label for="av">${esc(a.input.label)}</label><input id="av" required pattern="${esc(a.input.pattern)}">`:''}
    ${a.reason?`<label for="ar">Reason (saved in the audit log)</label><textarea id="ar" rows="2" required minlength="3"></textarea>`:''}
    ${a.confirm?`<label for="ac">Type <b>${esc(a.confirm)}</b> to confirm. This cannot be undone.</label><input id="ac" required autocomplete="off">`:''}
    <div class="acts"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn ${a.danger?'dgr':'pri'}" value="ok">${esc(a.label)}</button></div></form>`;
  dlg.showModal();
  dlg.onclose=async()=>{if(dlg.returnValue!=='ok')return;
    try{await api(`/api/p/${p.key}/e/${e.key}/${id}/${a.key}`,'POST',{reason:$('#ar')?.value,value:$('#av')?.value,confirm:$('#ac')?.value});toast('Done');route()}catch(x){toast(x.message)}};
}

/* ---------- system, audit, admins, account ---------- */
async function system(p){const s=await api(`/api/p/${p.key}/system`);
  shell(esc(p.name)+' · System',`<div class="card"><dl><dt>Database size</dt><dd>${esc(s.db.size)}</dd><dt>Postgres</dt><dd class="sm">${esc(s.db.version)}</dd><dt>Site</dt><dd><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></dd></dl></div>
  <h2>Tables (estimated rows)</h2>${table([['tbl','Table','mono'],['rows_est','Rows','num']],s.tables)}<h2>Migrations</h2>${table([['name','File','mono'],['applied_at','Applied','time']],s.migrations)}`)}
let ao=0,aq='';
async function audit(){const d=await api(`/api/audit?o=${ao}&q=${encodeURIComponent(aq)}`);
  shell('Audit log',`<form class="bar" id="sf" role="search"><input type="search" id="sq" placeholder="Admin, action or target ID" aria-label="Search audit log" value="${esc(aq)}"><button class="btn">Search</button></form>
  ${table([['at','When','time'],['admin_email','Admin'],['action','Action'],['project','Project'],['entity','Type'],['target','Target','mono'],['reason','Reason'],['ip','IP','mono']],d.rows)}
  <div class="bar" style="margin-top:10px"><button class="btn" data-act="apage" data-v="-1" ${ao?'':'disabled'}>Newer</button><button class="btn" data-act="apage" data-v="1" ${d.more?'':'disabled'}>Older</button></div><p class="sm mu">The audit log cannot be edited or deleted.</p>`);
  $('#sf').onsubmit=ev=>{ev.preventDefault();aq=$('#sq').value.trim();ao=0;route()}}
const projPick=sel=>`<fieldset style="border:0;padding:0;margin:10px 0 0"><legend class="sm mu">Projects (none ticked = all)</legend>${PROJ.map(p=>`<label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" name="pj" value="${p.key}" ${sel?.includes(p.key)?'checked':''} style="min-height:auto">${esc(p.name)}</label>`).join('')}</fieldset>`;
const roleSel=v=>`<select id="rl">${['viewer','support','owner'].map(r=>`<option ${r===v?'selected':''}>${r}</option>`).join('')}</select><p class="sm mu">Viewer: read only. Support: suspend, block, resets. Owner: everything, including deletes and admin users.</p>`;
async function admins(){const rows=await api('/api/admins');
  shell('Admin users',table([['email','Email'],['role','Role','tag'],['projects','Projects'],['disabled','Disabled','bool'],['last_login','Last login','time'],['locked_until','Locked until','time']],rows.map(r=>({...r,projects:r.projects?.join(', ')||'All'})),r=>`admins/${r.id}`),`<button class="btn pri" data-act="addadmin">Add admin</button>`);
  app._admins=rows}
function adminSheet(r){const dlg=$('#dlg'),self=r&&r.id===ME.id;
  dlg.innerHTML=`<form method="dialog"><h3>${r?esc(r.email):'Add admin'}</h3>${r?'':'<label for="ne">Email</label><input id="ne" type="email" required>'}
    <label for="rl">Role</label>${roleSel(r?.role||'support')}${projPick(r?.projects)}
    <div class="acts" style="flex-wrap:wrap">${r&&!self?`<button class="btn" value="${r.disabled?'enable':'disable'}" formnovalidate>${r.disabled?'Enable':'Disable'}</button><button class="btn" value="reset" formnovalidate>Reset password + 2FA</button>`:''}
    <button class="btn" value="cancel" formnovalidate>Cancel</button>${self?'':`<button class="btn pri" value="${r?'role':'add'}">${r?'Save role':'Add admin'}</button>`}</div></form>`;
  dlg.showModal();
  dlg.onclose=async()=>{const v=dlg.returnValue;if(!v||v==='cancel')return;const projects=[...dlg.querySelectorAll('[name=pj]:checked')].map(x=>x.value);
    try{let out;if(v==='add')out=await api('/api/admins','POST',{email:$('#ne').value,role:$('#rl').value,projects});else out=await api(`/api/admins/${r.id}/${v}`,'POST',{role:$('#rl').value,projects});
      if(out.password)secretSheet(r?.email||$('#ne')?.value,out);else{toast('Saved');route()}}catch(x){toast(x.message)}};
}
function secretSheet(email,o){const dlg=$('#dlg'),qr=qrcode(0,'M');qr.addData(o.uri);qr.make();
  dlg.innerHTML=`<form method="dialog"><h3>Send these to ${esc(email||'the admin')} privately</h3><p class="note">Shown only once. Share them in person or over a private channel.</p>
    <dl><dt>Password</dt><dd class="mono">${esc(o.password)}</dd><dt>2FA secret</dt><dd class="mono">${esc(o.secret)}</dd></dl>
    <p class="sm mu">Scan in Google Authenticator, Microsoft Authenticator or 1Password:</p><div class="qr">${qr.createSvgTag({cellSize:4,margin:0,scalable:true})}</div>
    <div class="acts"><button class="btn pri" value="ok">I have saved them</button></div></form>`;
  dlg.showModal();dlg.onclose=()=>route()}
function account(){shell('My account',`<form class="card" id="pf" style="max-width:420px"><h2 style="margin-top:0">Change password</h2><label for="cp">Current password</label><input id="cp" type="password" autocomplete="current-password" required style="width:100%">
  <label for="np">New password (12+ characters)</label><input id="np" type="password" autocomplete="new-password" minlength="12" required style="width:100%"><p class="sm mu">Signs out your other sessions.</p><button class="btn pri">Change password</button></form>
  <p class="sm mu" style="margin-top:14px">Lost your authenticator? Another owner can reset it in Admin users, or run <span class="mono">node scripts/create-admin.js ${esc(ME.email)}</span>.</p>`);
  $('#pf').onsubmit=async ev=>{ev.preventDefault();try{await api('/api/password','POST',{current:$('#cp').value,password:$('#np').value});toast('Password changed');ev.target.reset()}catch(x){toast(x.message)}}}

/* ---------- router + clicks ---------- */
async function route(){
  if(!ME)return login();const c=cur(),p=c.a==='p'&&proj(c.p);
  try{
    if(p&&c.b==='dash')await dash(p);
    else if(p&&c.b==='system')await system(p);
    else if(p&&c.b==='e'){const e=p.entities.find(x=>x.key===c.e);if(!e)throw new Error('Unknown page');c.id?await detail(p,e,c.id):await list(p,e)}
    else if(c.a==='audit')await audit();
    else if(c.a==='admins'){await admins();if(c.p){const r=app._admins.find(x=>x.id==c.p);if(r)adminSheet(r)}}
    else if(c.a==='account')account();
    else return location.hash=PROJ[0]?`#p/${PROJ[0].key}/dash`:'#audit';
  }catch(e){if(ME)shell('Error',`<div class="card">${esc(e.message)} <button class="btn" data-act="retry">Try again</button></div>`)}
}
document.addEventListener('click',async ev=>{
  const go=ev.target.closest('[data-go]');if(go&&!ev.target.closest('a')){location.hash='#'+go.dataset.go;return}
  const b=ev.target.closest('[data-act]');if(!b)return;const act=b.dataset.act;ev.preventDefault();
  if(act==='logout'){await api('/api/logout','POST',{}).catch(()=>{});ME=null;location.hash='';login()}
  if(act==='menu')$('#side').classList.toggle('open');
  if(act==='fresh')dash(proj(cur().p),1).catch(e=>toast(e.message));
  if(act==='filter'){state.f=b.dataset.v;state.o=0;route()}
  if(act==='page'){state.o=Math.max(0,state.o+50*b.dataset.v);route()}
  if(act==='apage'){ao=Math.max(0,ao+100*b.dataset.v);route()}
  if(act==='action')runAction(app._acts.find(a=>a.key===b.dataset.k));
  if(act==='addadmin')adminSheet(null);
  if(act==='retry')route();
});
document.addEventListener('keydown',ev=>{const go=ev.target.closest?.('[data-go]');if(go&&ev.key==='Enter')location.hash='#'+go.dataset.go});
addEventListener('hashchange',()=>{$('#side')?.classList.remove('open');route()});
async function boot(){try{const d=await api('/api/me');ME=d.me;PROJ=d.projects;route()}catch{}}
boot();

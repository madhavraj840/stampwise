require('dotenv').config();
/* Admin panel API (admin.bunkwise.in). One deployment serves every project in projects.js.
   Free-tier friendly: admin traffic is tiny, DB pools are created only when a project is opened, max 2 connections, 10 s idle. */
const express=require('express'),{Pool}=require('pg'),path=require('path'),crypto=require('crypto');
const {hashPw,checkPw,newTotp,checkTotp,sign,randPw}=require('./lib');
const PROJECTS=require('./projects');
const PROD=process.env.NODE_ENV==='production'||!!process.env.VERCEL;

const pools={};
const poolFor=url=>pools[url]||(pools[url]=new Pool({connectionString:url,max:2,idleTimeoutMillis:1e4}).on('error',e=>console.error('db:',e.message)));
// admin tables live in the "admin" schema; by default in the first project's database (no extra database to pay for)
const ADMIN_URL=process.env.ADMIN_DATABASE_URL||process.env.STAMPWISE_DATABASE_URL;
const aq=(s,p)=>poolFor(ADMIN_URL).query(s,p).then(r=>r.rows),aone=async(s,p)=>(await aq(s,p))[0];
const live=()=>Object.entries(PROJECTS).filter(([,p])=>process.env[p.db]);

const app=express();app.disable('x-powered-by');app.set('trust proxy',+(process.env.TRUST_PROXY??1));
app.use(express.json({limit:'64kb'}));
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
app.use((req,res,next)=>{res.set({'Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Cache-Control':'no-store'});
  if(PROD)res.set('Strict-Transport-Security','max-age=31536000');next()});
const err=(status,message)=>Object.assign(new Error(message),{status});
const h=fn=>(req,res,next)=>fn(req,res,next).catch(next);
// every write must come from our own page: JSON body + SameSite=Strict cookie (a form post from another site can do neither)
app.use('/api',(req,res,next)=>req.method!=='GET'&&!req.is('application/json')?res.status(415).json({error:'JSON only'}):next());

/* ---- sessions: signed cookie id.ver.issued_at.sig, 12 hours, checked against the DB on every request (admin traffic is tiny) ---- */
const RANK={viewer:1,support:2,owner:3},TTL=12*3600;
const issue=(res,a)=>{const v=`${a.id}.${a.token_ver}.${Math.floor(Date.now()/1e3)}`;res.append('Set-Cookie',`sid_a=${v}.${sign('a'+v)}; HttpOnly; Path=/; Max-Age=${TTL}; SameSite=Strict${PROD?'; Secure':''}`)};
const clear=res=>res.append('Set-Cookie','sid_a=; Path=/; Max-Age=0');
const A=(min='viewer')=>h(async(req,res,next)=>{
  const raw=((req.headers.cookie||'').split(/;\s*/).find(c=>c.startsWith('sid_a='))||'').slice(6),i=raw.lastIndexOf('.'),v=raw.slice(0,i);
  const[id,ver,iat]=v.split('.').map(Number),sig=Buffer.from(raw.slice(i+1)),exp=Buffer.from(sign('a'+v)),ok=i>0&&sig.length===exp.length&&crypto.timingSafeEqual(sig,exp)&&Date.now()/1e3-iat<TTL;
  const a=ok&&await aone('select id,email,role,projects,token_ver from admin.admin_users where id=$1 and not disabled',[id]);
  if(!a||a.token_ver!==ver){clear(res);throw err(401,'Please sign in')}
  if(RANK[a.role]<RANK[min])throw err(403,'Your role cannot do this');
  req.admin=a;next();
});
const canSee=(a,key)=>!a.projects?.length||a.projects.includes(key);
const audit=(req,o)=>aq('insert into admin.audit_log(admin_id,admin_email,project,entity,target,action,reason,detail,ip) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [req.admin.id,req.admin.email,o.project||null,o.entity||null,o.target!=null?String(o.target):null,o.action,o.reason||null,o.detail?JSON.stringify(o.detail):null,req.ip]);

/* ---- login: password + 6-digit authenticator code. 5 wrong tries lock the account for 15 minutes ---- */
const ipHits=new Map();
app.post('/api/login',h(async(req,res)=>{
  const now=Date.now(),k=req.ip;let e=ipHits.get(k);if(!e||e.r<now)ipHits.set(k,e={c:0,r:now+9e5});if(++e.c>20)throw err(429,'Too many attempts. Wait 15 minutes.');
  const email=String(req.body.email||'').trim().toLowerCase(),pw=String(req.body.password||''),code=String(req.body.code||'').replace(/\s/g,'');
  const a=await aone('select * from admin.admin_users where email=$1',[email]),bad=err(401,'Wrong email, password or code');
  if(!a||a.disabled){await checkPw(pw,'00:00');throw bad}
  if(a.locked_until&&new Date(a.locked_until)>now)throw err(429,'Locked after too many wrong tries. Wait 15 minutes.');
  const step=await checkPw(pw,a.pass_hash)&&checkTotp(a.totp_secret,code,+a.totp_last);
  if(!step){await aq(`update admin.admin_users set fails=fails+1,locked_until=case when fails+1>=5 then now()+interval '15 minutes' end where id=$1`,[a.id]);throw bad}
  await aq('update admin.admin_users set fails=0,locked_until=null,totp_last=$2,last_login=now() where id=$1',[a.id,step]);
  issue(res,a);req.admin=a;await audit(req,{action:'login'});res.json({ok:true});
}));
app.post('/api/logout',(req,res)=>{clear(res);res.json({ok:true})});
app.get('/api/me',A(),(req,res)=>{const a=req.admin;
  res.json({me:{id:a.id,email:a.email,role:a.role},projects:live().filter(([k])=>canSee(a,k)).map(([key,p])=>({key,name:p.name,url:p.url,
    entities:Object.entries(p.adapter.entities).map(([k,e])=>({key:k,label:e.label,cols:e.cols,filters:e.filters,
      actions:Object.entries(e.actions||{}).filter(([,x])=>RANK[a.role]>=RANK[x.role]).map(([k,x])=>({key:k,label:x.label,danger:!!x.danger,reason:!!x.reason,input:x.input,when:x.when,confirm:x.confirm}))}))}))})});
app.post('/api/password',A(),h(async(req,res)=>{
  const a=await aone('select pass_hash from admin.admin_users where id=$1',[req.admin.id]),pw=String(req.body.password||'');
  if(!await checkPw(String(req.body.current||''),a.pass_hash))throw err(400,'Current password is wrong');
  if(pw.length<12||pw.length>200)throw err(400,'Use 12 to 200 characters');
  const r=await aone('update admin.admin_users set pass_hash=$2,token_ver=token_ver+1 where id=$1 returning id,token_ver',[req.admin.id,await hashPw(pw)]);
  issue(res,r);await audit(req,{action:'change own password'});res.json({ok:true});
}));

/* ---- projects: stats, lists, detail, actions (all through the project's adapter) ---- */
const P=h(async(req,res,next)=>{const p=PROJECTS[req.params.p];if(!p||!process.env[p.db]||!canSee(req.admin,req.params.p))throw err(404,'Unknown project');
  req.p=p;req.q=(s,x)=>poolFor(process.env[p.db]).query(s,x).then(r=>r.rows);next()});
const E=(req)=>{const e=req.p.adapter.entities[req.params.e];if(!e)throw err(404,'Unknown list');return e};
const statsCache={};
app.get('/api/p/:p/stats',A(),P,h(async(req,res)=>{const c=statsCache[req.params.p]; // 60 s cache: a dashboard left open costs nothing
  if(!c||Date.now()-c.t>6e4||req.query.fresh)statsCache[req.params.p]={t:Date.now(),d:await req.p.adapter.stats(req.q)};res.json(statsCache[req.params.p].d)}));
app.get('/api/p/:p/system',A('owner'),P,h(async(req,res)=>res.json(await req.p.adapter.system(req.q))));
app.get('/api/p/:p/e/:e',A(),P,h(async(req,res)=>{const e=E(req);
  res.json(await e.list(req.q,{search:String(req.query.q||'').trim().slice(0,80),filter:String(req.query.f??e.filters[0][0]),offset:Math.max(0,+req.query.o||0)}))}));
app.get('/api/p/:p/e/:e/:id(\\d{1,9})',A(),P,h(async(req,res)=>{const d=await E(req).get(req.q,+req.params.id);if(!d)throw err(404,'Not found');
  if(d.audit)await audit(req,{project:req.params.p,entity:req.params.e,target:req.params.id,action:d.audit});res.json(d)}));
app.post('/api/p/:p/e/:e/:id(\\d{1,9})/:act',A(),P,h(async(req,res)=>{
  const x=E(req).actions?.[req.params.act];if(!x)throw err(404,'Unknown action');if(RANK[req.admin.role]<RANK[x.role])throw err(403,'Your role cannot do this');
  const reason=String(req.body.reason||'').trim().slice(0,500),value=String(req.body.value||'').trim();
  if(x.reason&&reason.length<3)throw err(400,'Write a short reason');
  if(x.input&&!new RegExp(x.input.pattern).test(value))throw err(400,'Check the value: '+x.input.label);
  if(x.confirm&&req.body.confirm!==x.confirm)throw err(400,`Type ${x.confirm} to confirm`);
  const r=await x.run(req.q,+req.params.id,{reason,value});
  await audit(req,{project:req.params.p,entity:req.params.e,target:req.params.id,action:req.params.act,reason,detail:x.input?{value}:r});res.json({ok:true});
}));

/* ---- audit log + admin users (owner only) ---- */
app.get('/api/audit',A(),h(async(req,res)=>{const o=Math.max(0,+req.query.o||0),s=String(req.query.q||'').trim();
  const rows=await aq(`select id,at,admin_email,project,entity,target,action,reason,detail,ip from admin.audit_log
    where ($1='' or admin_email ilike '%'||$1||'%' or action ilike '%'||$1||'%' or target=$1) order by id desc limit 101 offset $2`,[s,o]);
  res.json({rows:rows.slice(0,100),more:rows.length>100})}));
app.get('/api/admins',A('owner'),h(async(req,res)=>res.json(await aq('select id,email,role,projects,disabled,last_login,created_at,locked_until from admin.admin_users order by id'))));
const cleanProjects=p=>{const a=(Array.isArray(p)?p:[]).filter(k=>PROJECTS[k]);return a.length?a:null};
app.post('/api/admins',A('owner'),h(async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(),role=req.body.role;
  if(!/^\S+@\S+\.\S+$/.test(email)||!RANK[role])throw err(400,'Enter an email and a role');
  const pw=randPw(),t=newTotp(email);
  const r=await aone('insert into admin.admin_users(email,pass_hash,totp_secret,role,projects) values($1,$2,$3,$4,$5) on conflict(email) do nothing returning id',[email,await hashPw(pw),t.stored,role,cleanProjects(req.body.projects)]);
  if(!r)throw err(409,'That email is already an admin');
  await audit(req,{action:'add admin',target:email,detail:{role,projects:cleanProjects(req.body.projects)}});
  res.json({password:pw,secret:t.secret,uri:t.uri}); // shown once
}));
app.post('/api/admins/:id(\\d{1,9})/:act(disable|enable|role|reset)',A('owner'),h(async(req,res)=>{
  const id=+req.params.id,act=req.params.act;if(id===req.admin.id&&act!=='reset')throw err(400,'You cannot change your own account here');
  let out={ok:true},r;
  if(act==='disable')r=await aone('update admin.admin_users set disabled=true,token_ver=token_ver+1 where id=$1 returning email',[id]);
  if(act==='enable')r=await aone('update admin.admin_users set disabled=false,fails=0,locked_until=null where id=$1 returning email',[id]);
  if(act==='role'){if(!RANK[req.body.role])throw err(400,'Pick a role');
    r=await aone('update admin.admin_users set role=$2,projects=$3,token_ver=token_ver+1 where id=$1 returning email',[id,req.body.role,cleanProjects(req.body.projects)])}
  if(act==='reset'){const pw=randPw(),em=(await aone('select email from admin.admin_users where id=$1',[id]))?.email;if(!em)throw err(404,'Not found');const t=newTotp(em);
    r=await aone('update admin.admin_users set pass_hash=$2,totp_secret=$3,totp_last=0,fails=0,locked_until=null,token_ver=token_ver+1 where id=$1 returning email',[id,await hashPw(pw),t.stored]);
    out={password:pw,secret:t.secret,uri:t.uri}}
  if(!r)throw err(404,'Not found');
  await audit(req,{action:act==='reset'?'reset admin password + 2FA':act+' admin',target:r.email,detail:act==='role'?{role:req.body.role}:null});
  if(id===req.admin.id)clear(res);res.json(out);
}));

app.use(express.static(path.join(__dirname,'public'))); // local runs; on Vercel the CDN serves public/
app.use('/api',(req,res)=>res.status(404).json({error:'Not found'}));
app.use((e,req,res,next)=>{if(!e.status)console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Server error'})});
if(!ADMIN_URL)console.warn('Set STAMPWISE_DATABASE_URL (and optionally ADMIN_DATABASE_URL)');
module.exports=app;
if(require.main===module)app.listen(+process.env.PORT||4000,()=>console.log('admin on http://localhost:'+(+process.env.PORT||4000)));

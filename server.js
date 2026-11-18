require('dotenv').config();
const express=require('express'),{Pool}=require('pg'),crypto=require('crypto'),path=require('path'),QR=require('qrcode');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:+process.env.DB_POOL_MAX||10,keepAlive:true});
// without this, the database closing an idle connection (Neon does this) crashes the whole app
pool.on('error',e=>console.error('db idle client error:',e.message));
const app=express(),PROD=process.env.NODE_ENV==='production';
app.disable('x-powered-by');
// number of proxies in front of the app (1 = one load balancer). Wrong value = rate limits see the wrong IP. See README "Hosting"
app.set('trust proxy',+(process.env.TRUST_PROXY??1));app.use(express.json({limit:'1mb'}));
const CSP="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.use((q,r,n)=>{r.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':CSP,'Permissions-Policy':'camera=(self), microphone=(), geolocation=()'});
  if(PROD)r.set('Strict-Transport-Security','max-age=31536000');n()});
// Neon only: keep the database awake so the first click after a pause is not slow (costs compute hours; set KEEP_DB_WARM=0 to turn off)
if(process.env.KEEP_DB_WARM!=='0')setInterval(()=>pool.query('select 1').catch(()=>{}),24e4).unref();

const q=(s,p)=>pool.query(s,p).then(r=>r.rows), one=async(s,p)=>(await q(s,p))[0];
const err=(status,message,code)=>Object.assign(new Error(message),{status,code});
const h=fn=>(req,res,next)=>fn(req,res,next).catch(next);
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
/* ---- rate limits: fixed window per (limit name + key). key = IP by default, or the account / email being targeted ----
   ponytail: in-memory, per process. Running 2+ app instances needs a shared store (Redis or a Postgres table), see README "Scaling" */
const hits=new Map();
setInterval(()=>{const now=Date.now();for(const[k,e]of hits)if(e.reset<now)hits.delete(k)},6e4).unref();
const ipKey=ip=>ip&&ip.includes(':')&&!ip.startsWith('::ffff:')?ip.split(':').slice(0,4).join(':'):ip; // IPv6: one /64 = one user, so rotating addresses does not dodge limits
const limit=(name,n,ms,key=req=>ipKey(req.ip))=>(req,res,next)=>{
  const k=name+':'+key(req),now=Date.now();let e=hits.get(k);if(!e||e.reset<now)hits.set(k,e={c:0,reset:now+ms});
  ++e.c>n?res.status(429).json({error:'Too many attempts. Try again in a few minutes.'}):next();
};
const normPhone=s=>{const d=String(s||'').replace(/\D/g,'').replace(/^(91|0)(?=\d{10}$)/,'');return /^[6-9]\d{9}$/.test(d)?d:null};
const TODAY="date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'";

/* ---- live updates (server-sent events) ---- */
const subs=new Map();
const push=(key,ev)=>subs.get(key)?.forEach(r=>r.write(`data: ${JSON.stringify(ev)}\n\n`));
// ponytail: in-process. With 2+ instances an approval on one will not reach a phone connected to another; upgrade = Redis pub/sub (README "Scaling")
const events=role=>(req,res)=>{
  const k=role+':'+req.uid;if(!subs.has(k))subs.set(k,new Set());
  if(subs.get(k).size>=10)return res.status(429).end(); // one account cannot hold open unlimited connections
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();res.write('retry: 3000\n\n');
  subs.get(k).add(res);
  const t=setInterval(()=>res.write(':\n\n'),25e3);req.on('close',()=>{clearInterval(t);const s=subs.get(k);s?.delete(res);if(s&&!s.size)subs.delete(k)});
};

/* ---- sessions: cached in memory so most requests skip the database lookup ---- */
const CK={customer:'sid_c',shop:'sid_s'},sc=new Map();
// housekeeping: drop expired cache entries every minute; expired sessions and stale reset requests every hour
setInterval(()=>{const now=Date.now();for(const[k,c]of sc)if(c.exp<now)sc.delete(k)},6e4).unref();
setInterval(()=>pool.query("delete from sessions where expires_at<now(); update password_resets set status='expired',resolved_at=now() where status='pending' and requested_at<now()-interval '2 days'").catch(e=>console.error('cleanup:',e.message)),36e5).unref();
const setCookie=(res,role,t)=>res.append('Set-Cookie',`${CK[role]}=${t}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${PROD?'; Secure':''}`);
async function startSession(res,role,id){
  const t=crypto.randomBytes(32).toString('hex');
  await q("insert into sessions values($1,$2,$3,now()+interval '365 days')",[sha(t),role,id]);
  setCookie(res,role,t);
}
const tokenOf=(req,role)=>((req.headers.cookie||'').split(/;\s*/).find(c=>c.startsWith(CK[role]+'='))||'').slice(CK[role].length+1);
async function whoIs(req,role){
  const t=tokenOf(req,role);if(!t)return null;const k=role+sha(t),c=sc.get(k);if(c&&c.exp>Date.now())return c.id;
  // every database check also renews the session: you stay signed in for a year after your LAST visit
  const s=await one("update sessions set expires_at=now()+interval '365 days' where token_hash=$1 and role=$2 and expires_at>now() returning subject_id",[sha(t),role]);
  if(!s){sc.delete(k);return null}sc.set(k,{id:s.subject_id,exp:Date.now()+3e5});req.renew=[role,t];return s.subject_id;
}
const auth=role=>h(async(req,res,next)=>{const id=await whoIs(req,role);if(!id)return res.status(401).json({error:'Please sign in'});if(req.renew)setCookie(res,role,req.renew[1]);req.uid=id;next()});
const logout=role=>h(async(req,res)=>{const t=tokenOf(req,role);if(t){sc.delete(role+sha(t));await q('delete from sessions where token_hash=$1',[sha(t)])}res.append('Set-Cookie',`${CK[role]}=; Path=/; Max-Age=0`);res.json({ok:true})});

/* ---- OTP hook: today it lets everyone through. Later: send/verify a code here and set phone_verified=true. ---- */
async function verifyPhone(phone,body){return true}

/* ================= CUSTOMER ================= */
const pubC=c=>({id:c.id,name:c.name,phone:c.phone,since:c.created_at});
const C=auth('customer');
app.post('/api/auth/login',limit('login',20,6e5),h(async(req,res)=>{
  const phone=normPhone(req.body.phone),name=String(req.body.name||'').trim().replace(/\s+/g,' ').slice(0,60);
  if(!phone)throw err(400,'Enter a valid 10-digit mobile number');
  if(!await verifyPhone(phone,req.body))throw err(401,'Verification failed');
  let c=await one('select * from customers where phone=$1',[phone]);
  // the PHONE NUMBER is the account. The name is just a label: new numbers need one, returning customers may leave it blank or type a new one
  if(!c){if(name.length<2)throw err(400,'New here? Add your name to create your card.','NAME_REQUIRED');
    c=await one('insert into customers(phone,name) values($1,$2) on conflict(phone) do update set phone=excluded.phone returning *',[phone,name])}
  else if(name.length>=2&&name!==c.name)c=await one('update customers set name=$2 where id=$1 returning *',[c.id,name]);
  await startSession(res,'customer',c.id);res.json({customer:pubC(c)});
}));
app.post('/api/auth/logout',logout('customer'));
app.get('/api/me',C,h(async(req,res)=>res.json({customer:pubC(await one('select * from customers where id=$1',[req.uid]))})));
app.patch('/api/me',C,h(async(req,res)=>{
  const name=String(req.body.name||'').trim().replace(/\s+/g,' ').slice(0,60);if(name.length<2)throw err(400,'Name is too short');
  res.json({customer:pubC(await one('update customers set name=$2 where id=$1 returning *',[req.uid,name]))});
}));
app.get('/api/events',C,events('cust'));
// a shop can be found by its link slug, its short code, or a pasted link
const findShop=async key=>{key=String(key||'').trim();const m=key.match(/\/s\/([^/?#\s]+)/);if(m)key=m[1];return key?one('select * from shops where slug=lower($1) or code=upper($1)',[key]):null};
app.get('/api/shop-public/:key',limit('lookup',60,6e5),h(async(req,res)=>{const s=await findShop(req.params.key);if(!s)throw err(404,'This QR code or shop code is not valid');res.json({name:s.name,slug:s.slug})}));

async function decide(id,shopId,ok){
  const c=await pool.connect();let cust;
  try{await c.query('begin');
    const r=(await c.query("select * from stamp_requests where id=$1 and shop_id=$2 and status='pending' for update",[id,shopId])).rows[0];
    if(!r)throw err(404,'This request was already handled');cust=r.customer_id;
    await c.query('update stamp_requests set status=$2,decided_at=now() where id=$1',[id,ok?'approved':'declined']);
    if(ok){
      const k=(await c.query('update cards set stamps=stamps+1,visits=visits+1,last_visit=now() where customer_id=$1 and shop_id=$2 returning stamps',[r.customer_id,shopId])).rows[0];
      await c.query("insert into claims(reward_id,shop_id,customer_id,title,code,expires_at) select id,shop_id,$1,title,lpad(floor(random()*10000)::int::text,4,'0'),now()+expiry_days*interval '1 day' from rewards where shop_id=$2 and active and stamps_required=$3",[r.customer_id,shopId,k.stamps]);
      const sz=(await c.query('select card_size from shops where id=$1',[shopId])).rows[0].card_size;
      if(k.stamps>=sz)await c.query('update cards set stamps=0,cycles=cycles+1 where customer_id=$1 and shop_id=$2',[r.customer_id,shopId]);
    }
    await c.query('commit');
  }catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}
  push('cust:'+cust,{t:'update'});push('shop:'+shopId,{t:'update'});
}
async function requestStamp(uid,s){
  await q('insert into cards(customer_id,shop_id) values($1,$2) on conflict do nothing',[uid,s.id]);
  const a=[uid,s.id];
  if(await one("select 1 from stamp_requests where customer_id=$1 and shop_id=$2 and status='pending'",a))return 'pending';
  if(!s.multi_per_day&&await one(`select 1 from stamp_requests where customer_id=$1 and shop_id=$2 and status='approved' and decided_at>=${TODAY}`,a))return 'already_today';
  const r=await one('insert into stamp_requests(customer_id,shop_id) values($1,$2) on conflict do nothing returning id',a);
  if(!r)return 'pending';
  if(s.auto_approve){await decide(r.id,s.id,true);return 'approved'}
  push('shop:'+s.id,{t:'pending'});return 'pending';
}
// scan a QR link / enter a shop code: joins the shop and asks for a stamp
app.post('/api/scan/:key',C,limit('stamp',30,6e5,req=>req.uid),h(async(req,res)=>{
  const s=await findShop(req.params.key);if(!s)throw err(404,'This QR code or shop code is not valid');
  res.json({status:await requestStamp(req.uid,s),shop_id:s.id});
}));
// "Request stamp" button on a card the customer already has
app.post('/api/cards/:shopId(\\d{1,9})/request',C,limit('stamp',30,6e5,req=>req.uid),h(async(req,res)=>{
  const s=await one('select s.* from shops s join cards k on k.shop_id=s.id where s.id=$1 and k.customer_id=$2',[+req.params.shopId,req.uid]);
  if(!s)throw err(404,'Card not found');res.json({status:await requestStamp(req.uid,s),shop_id:s.id});
}));
app.get('/api/home',C,h(async(req,res)=>{
  const [cards,rw,claims]=await Promise.all([
    q(`select s.id shop_id,s.name,s.slug,s.phone,s.address,s.hours,s.card_size,s.stamp_icon,k.stamps,k.visits,
      exists(select 1 from stamp_requests r where r.customer_id=k.customer_id and r.shop_id=s.id and r.status='pending') pending
      from cards k join shops s on s.id=k.shop_id where k.customer_id=$1 order by coalesce(k.last_visit,k.created_at) desc`,[req.uid]),
    q('select shop_id,id,title,stamps_required,expiry_days from rewards where active and shop_id in(select shop_id from cards where customer_id=$1) order by stamps_required',[req.uid]),
    q("select id,reward_id,shop_id,title,code,expires_at from claims where customer_id=$1 and status='earned' and expires_at>now() order by earned_at",[req.uid])]);
  cards.forEach(c=>{c.rewards=rw.filter(r=>r.shop_id===c.shop_id);c.claims=claims.filter(l=>l.shop_id===c.shop_id)});
  res.json({cards,claims,visits:cards.reduce((a,c)=>a+c.visits,0)});
}));
app.get('/api/rewards',C,h(async(req,res)=>res.json(await q(`select c.id,c.title,c.code,c.status,c.earned_at,c.expires_at,c.redeemed_at,s.name shop,
  (c.status='earned' and c.expires_at<=now()) expired from claims c join shops s on s.id=c.shop_id where c.customer_id=$1 order by c.earned_at desc limit 200`,[req.uid]))));

/* ================= SHOP ================= */
const SUPPORT=(process.env.SUPPORT_WHATSAPP||'').replace(/\D/g,'').replace(/^(?=\d{10}$)/,'91');if(!/^\d{11,15}$/.test(SUPPORT))console.warn('SUPPORT_WHATSAPP is not set: password reset requests will not open WhatsApp');
// async scrypt: the old scryptSync blocked every other request while it hashed. Same hash format, existing passwords still work
const scrypt=require('util').promisify(crypto.scrypt),PW_MAX=200; // no max length = a 1 MB password burns CPU
const hashPw=async(p,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+(await scrypt(p,salt,64)).toString('hex');
const checkPw=async(p,st)=>{if(p.length>PW_MAX)return false;const[s,k]=st.split(':'),a=Buffer.from(k,'hex'),b=await scrypt(p,s,64);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const pwProblem=pw=>pw.length<8?'at least 8 characters':pw.length>PW_MAX?`at most ${PW_MAX} characters`:null;
const slugify=s=>(s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'shop')+'-'+crypto.randomBytes(2).toString('hex');
const genCode=()=>Array.from(crypto.randomBytes(6),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
app.post('/api/shop/signup',limit('signup',10,36e5),h(async(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,80),email=String(req.body.email||'').trim().toLowerCase(),pw=String(req.body.password||'');
  if(name.length<2)throw err(400,'Enter your shop name');
  if(!/^\S+@\S+\.\S+$/.test(email))throw err(400,'Enter a valid email');
  if(pwProblem(pw))throw err(400,'Password must be '+pwProblem(pw));
  if(await one('select 1 from shops where email=$1',[email]))throw err(409,'This email is already registered');
  let s;for(let i=0;i<5&&!s;i++)try{s=await one('insert into shops(slug,code,name,email,pass_hash,phone) values($1,$2,$3,$4,$5,$6) returning id',[slugify(name),genCode(),name,email,await hashPw(pw),normPhone(req.body.phone)])}catch(e){if(e.code!=='23505')throw e}
  if(!s)throw err(500,'Could not create shop, try again');
  await startSession(res,'shop',s.id);res.json({ok:true});
}));
app.post('/api/shop/login',limit('shop-login',15,6e5),limit('shop-login-email',10,9e5,req=>String(req.body.email||'').trim().toLowerCase()),h(async(req,res)=>{
  const s=await one('select id,pass_hash from shops where email=$1',[String(req.body.email||'').trim().toLowerCase()]);
  if(!s||!await checkPw(String(req.body.password||''),s.pass_hash))throw err(401,'Wrong email or password');
  await startSession(res,'shop',s.id);res.json({ok:true});
}));
app.post('/api/shop/logout',logout('shop'));
// "Forgot password": the shop picks a NEW password, it is stored hashed in a pending request, and nothing changes until the owner approves it in the database
app.post('/api/shop/reset-request',limit('reset',5,36e5),h(async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase(),pw=String(req.body.password||'');
  if(!/^\S+@\S+\.\S+$/.test(email))throw err(400,'Enter your shop email');
  if(pwProblem(pw))throw err(400,'New password must be '+pwProblem(pw));
  const ref=String(crypto.randomInt(100000,1000000)),hash=await hashPw(pw),s=await one('select id,name,phone from shops where email=$1',[email]);
  if(s){ // same answer whether or not the email exists, so nobody can probe which emails are registered
    // older pending requests are NOT expired here: otherwise anyone could cancel a real request by sending one after it. The owner approves by ref; stale ones expire after 2 days
    await q('insert into password_resets(shop_id,ref,email,shop_name,shop_phone,new_pass_hash) values($1,$2,$3,$4,$5,$6)',[s.id,ref,email,s.name,s.phone,hash]);
  }
  res.json({ok:true,code:'RST-'+ref,support:SUPPORT||null});
}));
const S=auth('shop');
const BASE=req=>process.env.BASE_URL||`${req.protocol}://${req.get('host')}`;
app.get('/api/shop/events',S,events('shop'));
// everything the dashboard needs in ONE request (queries run in parallel)
app.get('/api/shop/bootstrap',S,h(async(req,res)=>{
  const id=req.uid,ist="(now() at time zone 'Asia/Kolkata')::date";
  const [me,pending,customers,rewards,claims,days,stats]=await Promise.all([
    one('select id,slug,code,name,email,phone,address,hours,card_size,stamp_icon,auto_approve,multi_per_day,plan from shops where id=$1',[id]),
    q(`select r.id,r.created_at,c.name,c.phone,k.stamps,k.visits from stamp_requests r join customers c on c.id=r.customer_id
      join cards k on k.customer_id=r.customer_id and k.shop_id=r.shop_id where r.shop_id=$1 and r.status='pending' order by r.created_at`,[id]),
    q(`select c.id,c.name,c.phone,k.stamps,k.visits,k.cycles,k.created_at joined,k.last_visit,
      (select count(*) from claims l where l.customer_id=c.id and l.shop_id=k.shop_id and l.status='earned' and l.expires_at>now())::int rewards_waiting,
      (select count(*) from claims l where l.customer_id=c.id and l.shop_id=k.shop_id)::int rewards_earned,
      (select count(*) from claims l where l.customer_id=c.id and l.shop_id=k.shop_id and l.status='redeemed')::int rewards_redeemed,
      (select coalesce(json_agg(t order by t desc),'[]') from (select decided_at t from stamp_requests r where r.customer_id=c.id and r.shop_id=k.shop_id and r.status='approved' order by decided_at desc limit 10) x) history
      from cards k join customers c on c.id=k.customer_id where k.shop_id=$1 order by k.last_visit desc nulls last limit 1000`,[id]),
    q('select id,title,stamps_required,expiry_days from rewards where shop_id=$1 and active order by stamps_required,id',[id]),
    q(`select l.id,l.title,l.code,l.status,l.earned_at,l.expires_at,l.redeemed_at,c.name,c.phone,(l.status='earned' and l.expires_at<=now()) expired
      from claims l join customers c on c.id=l.customer_id where l.shop_id=$1 order by (l.status='earned' and l.expires_at>now()) desc,l.earned_at desc limit 300`,[id]),
    q(`select to_char(d,'DD Mon') label,
      (select count(*) from stamp_requests r where r.shop_id=$1 and r.status='approved' and (r.decided_at at time zone 'Asia/Kolkata')::date=d::date)::int scans,
      (select count(*) from cards k where k.shop_id=$1 and (k.created_at at time zone 'Asia/Kolkata')::date<=d::date)::int customers
      from generate_series(${ist}-6,${ist},'1 day') d`,[id]),
    one(`select (select count(*) from stamp_requests where shop_id=$1 and status='approved')::int scans,
      (select count(*) from stamp_requests where shop_id=$1 and status='approved' and decided_at>=${TODAY})::int today,
      (select count(*) from cards where shop_id=$1)::int customers,(select count(*) from cards where shop_id=$1 and visits>1)::int repeat,
      (select count(*) from claims where shop_id=$1)::int earned,(select count(*) from claims where shop_id=$1 and status='earned' and expires_at>now())::int waiting`,[id])]);
  me.scan_url=`${BASE(req)}/s/${me.slug}`;res.json({me,pending,customers,rewards,claims,days,stats});
}));
const STAMPS=['star','coffee','heart','flower','paw','scissors','pizza','burger','cake','icecream','tshirt','book'];
app.patch('/api/shop/settings',S,h(async(req,res)=>{
  const b=req.body,str=(v,n)=>typeof v==='string'?v.trim().slice(0,n):null,bool=v=>typeof v==='boolean'?v:null;
  const size=Number(b.card_size)>=2&&Number(b.card_size)<=30?Math.floor(b.card_size):null;
  if(size&&await one('select 1 from rewards where shop_id=$1 and active and stamps_required>$2',[req.uid,size]))throw err(400,'A reward needs more stamps than this card size. Edit or remove it first.');
  await q('update shops set name=coalesce($2,name),phone=coalesce($3,phone),address=coalesce($4,address),hours=coalesce($5,hours),card_size=coalesce($6,card_size),auto_approve=coalesce($7,auto_approve),multi_per_day=coalesce($8,multi_per_day),stamp_icon=coalesce($9,stamp_icon) where id=$1',
    [req.uid,str(b.name,80)||null,str(b.phone,20),str(b.address,200),str(b.hours,60),size,bool(b.auto_approve),bool(b.multi_per_day),STAMPS.includes(b.stamp_icon)?b.stamp_icon:null]);
  res.json({ok:true});
}));
app.get('/api/shop/qr.svg',S,h(async(req,res)=>{
  const s=await one('select slug from shops where id=$1',[req.uid]);
  res.type('image/svg+xml').send(await QR.toString(`${BASE(req)}/s/${s.slug}`,{type:'svg',margin:1,width:320}));
}));
app.post('/api/shop/requests/:id(\\d{1,9})/:act(approve|decline)',S,h(async(req,res)=>{await decide(+req.params.id,req.uid,req.params.act==='approve');res.json({ok:true})}));
async function rewardBody(req){
  const title=String(req.body.title||'').trim().slice(0,80),n=Math.floor(+req.body.stamps_required),d=Math.floor(+req.body.expiry_days)||30;
  const sh=await one('select card_size from shops where id=$1',[req.uid]);
  if(title.length<2)throw err(400,'Describe the reward');
  if(!(n>=1&&n<=sh.card_size))throw err(400,`Stamps required must be between 1 and ${sh.card_size}`);
  if(!(d>=1&&d<=365))throw err(400,'Expiry must be 1 to 365 days');
  return [title,n,d];
}
app.post('/api/shop/rewards',S,h(async(req,res)=>{await q('insert into rewards(shop_id,title,stamps_required,expiry_days) values($1,$2,$3,$4)',[req.uid,...await rewardBody(req)]);res.json({ok:true})}));
app.patch('/api/shop/rewards/:id(\\d{1,9})',S,h(async(req,res)=>{await q('update rewards set title=$3,stamps_required=$4,expiry_days=$5 where id=$1 and shop_id=$2',[+req.params.id,req.uid,...await rewardBody(req)]);res.json({ok:true})}));
app.delete('/api/shop/rewards/:id(\\d{1,9})',S,h(async(req,res)=>{await q('update rewards set active=false where id=$1 and shop_id=$2',[+req.params.id,req.uid]);res.json({ok:true})}));
app.post('/api/shop/claims/:id(\\d{1,9})/redeem',S,h(async(req,res)=>{
  const r=await one("update claims set status='redeemed',redeemed_at=now() where id=$1 and shop_id=$2 and status='earned' and expires_at>now() returning customer_id",[+req.params.id,req.uid]);
  if(!r)throw err(404,'Reward not available (already redeemed or expired)');
  push('cust:'+r.customer_id,{t:'update'});res.json({ok:true});
}));
// add one or many customers (typed in, or from a CSV/Excel list): creates their cards automatically
app.post('/api/shop/customers/import',S,limit('import',30,36e5,req=>req.uid),h(async(req,res)=>{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw err(400,'No customers to add');if(rows.length>2000)throw err(400,'Please import 2000 customers or fewer at a time');
  const sh=await one('select card_size from shops where id=$1',[req.uid]),seen=new Set(),ok=[],bad=[];
  rows.forEach((r,i)=>{const p=normPhone(r.phone),n=String(r.name||'').trim().replace(/\s+/g,' ').slice(0,60)||'Customer',st=Math.min(Math.max(parseInt(r.stamps)||0,0),sh.card_size-1);
    if(!p)bad.push({row:r.row||i+1,reason:'Invalid mobile number'});else if(seen.has(p))bad.push({row:r.row||i+1,reason:'Duplicate number in the list'});else{seen.add(p);ok.push([p,n,st])}});
  if(!ok.length)return res.json({total:rows.length,new_customers:0,cards_added:0,already:0,invalid:bad});
  const r=await one(`with input as(select * from unnest($1::text[],$2::text[],$3::int[]) as t(phone,name,stamps)),
    ins as(insert into customers(phone,name) select phone,name from input on conflict(phone) do nothing returning id,phone),
    allc as(select id,phone from ins union select c.id,c.phone from customers c join input i on i.phone=c.phone),
    cd as(insert into cards(customer_id,shop_id,stamps,visits) select a.id,$4,i.stamps,i.stamps from allc a join input i on i.phone=a.phone on conflict do nothing returning customer_id)
    select (select count(*) from ins)::int new_customers,(select count(*) from cd)::int cards_added`,[ok.map(x=>x[0]),ok.map(x=>x[1]),ok.map(x=>x[2]),req.uid]);
  push('shop:'+req.uid,{t:'update'});
  res.json({total:rows.length,new_customers:r.new_customers,cards_added:r.cards_added,already:ok.length-r.cards_added,invalid:bad});
}));
app.delete('/api/shop/customers/:id(\\d{1,9})',S,h(async(req,res)=>{
  const a=[+req.params.id,req.uid];
  await q('with a as(delete from stamp_requests where customer_id=$1 and shop_id=$2),b as(delete from claims where customer_id=$1 and shop_id=$2) delete from cards where customer_id=$1 and shop_id=$2',a);
  push('cust:'+a[0],{t:'update'});res.json({ok:true});
}));

/* ================= PAGES ================= */
const pub=f=>(q,r)=>r.sendFile(path.join(__dirname,'public',f));
app.get('/healthz',(q,r)=>r.send('ok'));
app.get(['/','/s/:slug'],pub('customer.html'));app.get('/shop',pub('shop.html'));
app.use(express.static(path.join(__dirname,'public'),{maxAge:PROD?'1h':0}));
app.use('/api',(q,r)=>r.status(404).json({error:'Not found'}));
app.use((e,req,res,next)=>{if(!e.status)console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Server error. Please try again.',code:e.code})});
if(PROD&&!process.env.BASE_URL)console.warn('BASE_URL is not set: QR codes will use whatever host the request came in on');
const server=app.listen(process.env.PORT||3000,()=>console.log('Stampwise running'));
// hosts (Render, Railway, Fly, Docker, Kubernetes) send SIGTERM before replacing the app: finish requests, close live streams and DB connections
const stop=()=>{server.close(()=>pool.end().finally(()=>process.exit(0)));subs.forEach(set=>set.forEach(r=>r.end()));setTimeout(()=>process.exit(0),1e4).unref()};
process.on('SIGTERM',stop);process.on('SIGINT',stop);

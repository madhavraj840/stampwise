require('dotenv').config();
const express=require('express'),{Pool}=require('pg'),crypto=require('crypto'),path=require('path');
/* Built for free tiers (Vercel Hobby + Neon Free): no background timers, no open connections, no per-request session lookup,
   lists sync only what changed, stats come from a per-day rollup table. Runs the same on any Node host (see server.js). */
const PROD=process.env.NODE_ENV==='production'||!!process.env.VERCEL;
// small pool + short idle timeout: serverless instances stay cheap and Neon can scale to zero
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:+process.env.DB_POOL_MAX||4,idleTimeoutMillis:1e4});
pool.on('error',e=>console.error('db idle client error:',e.message)); // Neon closing an idle connection must not crash the app
const app=express();app.locals.pool=pool;
app.disable('x-powered-by');
app.set('trust proxy',+(process.env.TRUST_PROXY??1)); // proxies in front of the app; wrong value = limits see the wrong IP
app.use(express.json({limit:'1mb'}));
const CSP="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
app.use((q,r,n)=>{r.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':CSP,'Permissions-Policy':'camera=(self), microphone=(), geolocation=()'});
  if(PROD)r.set('Strict-Transport-Security','max-age=31536000');n()});

const q=(s,p)=>pool.query(s,p).then(r=>r.rows), one=async(s,p)=>(await q(s,p))[0];
const err=(status,message,code)=>Object.assign(new Error(message),{status,code});
const h=fn=>(req,res,next)=>fn(req,res,next).catch(next);
const sha=t=>crypto.createHash('sha256').update(t).digest('hex');
const normPhone=s=>{const d=String(s||'').replace(/\D/g,'').replace(/^(91|0)(?=\d{10}$)/,'');return /^[6-9]\d{9}$/.test(d)?d:null};
const TODAY="date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'",DAY="(now() at time zone 'Asia/Kolkata')::date";

/* ---- rate limits ----
   limit(): in memory, per instance, free. Good enough for cheap endpoints (a serverless instance is reused for many requests).
   dbLimit(): shared by all instances, one tiny upsert. Only on rare, sensitive actions (login, signup, password reset). */
const hits=new Map();
const ipKey=ip=>ip&&ip.includes(':')&&!ip.startsWith('::ffff:')?ip.split(':').slice(0,4).join(':'):ip; // IPv6: one /64 = one user
const limit=(name,n,ms,key=req=>ipKey(req.ip))=>(req,res,next)=>{
  const now=Date.now();if(hits.size>5e3)for(const[k,e]of hits)if(e.reset<now)hits.delete(k); // lazy sweep, no timer
  const k=name+':'+key(req);let e=hits.get(k);if(!e||e.reset<now)hits.set(k,e={c:0,reset:now+ms});
  ++e.c>n?res.status(429).json({error:'Too many attempts. Try again in a few minutes.'}):next();
};
const dbLimit=(name,n,secs,key=req=>ipKey(req.ip))=>h(async(req,res,next)=>{
  const r=await one(`insert into rate_limits values($1,1,now()+make_interval(secs=>$2)) on conflict(k) do update set
    n=case when rate_limits.reset_at<now() then 1 else rate_limits.n+1 end,reset_at=case when rate_limits.reset_at<now() then excluded.reset_at else rate_limits.reset_at end returning n`,[name+':'+key(req),secs]);
  if(r.n>n)throw err(429,'Too many attempts. Try again in a few minutes.');next();
});

/* ---- sessions: signed cookies, no sessions table ----
   cookie = id.token_ver.issued_at.signature. Verified with a hash, no database. Once an hour the account is re-checked
   (still active? token_ver unchanged?) and the cookie is re-issued, so "log out all devices", suspend and block apply within an hour. */
const SECRET=process.env.SESSION_SECRET||sha('stampwise:'+process.env.DATABASE_URL);
if(PROD&&!process.env.SESSION_SECRET)console.warn('SESSION_SECRET is not set: sessions are signed with a key derived from DATABASE_URL (changing the DB password logs everyone out)');
const CK={customer:'sid_c',shop:'sid_s'},TBL={customer:'customers',shop:'shops'},RECHECK=3600;
const sign=s=>crypto.createHmac('sha256',SECRET).update(s).digest('base64url');
const issue=(res,role,id,ver)=>{const v=`${id}.${ver}.${Math.floor(Date.now()/1e3)}`;res.append('Set-Cookie',`${CK[role]}=${v}.${sign(role+v)}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${PROD?'; Secure':''}`)};
const clear=(res,role)=>res.append('Set-Cookie',`${CK[role]}=; Path=/; Max-Age=0`);
const cookie=(req,n)=>((req.headers.cookie||'').split(/;\s*/).find(c=>c.startsWith(n+'='))||'').slice(n.length+1);
async function whoIs(req,res,role){
  const raw=cookie(req,CK[role]),i=raw.lastIndexOf('.');if(i<1)return null;
  const v=raw.slice(0,i),m=Buffer.from(raw.slice(i+1)),x=Buffer.from(sign(role+v));
  if(m.length!==x.length||!crypto.timingSafeEqual(m,x))return null;
  const[id,ver,iat]=v.split('.').map(Number),age=Date.now()/1e3-iat;if(!(id>0)||age>365*86400)return null;
  if(age>RECHECK){const a=await one(`select token_ver,status from ${TBL[role]} where id=$1`,[id]);if(!a||a.token_ver!==ver||a.status!=='active')return null;issue(res,role,id,ver)}
  return id;
}
const auth=role=>h(async(req,res,next)=>{const id=await whoIs(req,res,role);if(!id){clear(res,role);return res.status(401).json({error:'Please sign in'})}req.uid=id;next()});
const startSession=(res,role,a)=>issue(res,role,a.id,a.token_ver);

/* ---- OTP hook: today it lets everyone through. Later: send/verify a code here and set phone_verified=true. ---- */
async function verifyPhone(phone,body){return true}

/* ---- web push (optional: set VAPID keys). Tells the shop's devices about a new request; the dashboard then syncs. ---- */
const webpush=process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY?require('web-push'):null;
if(webpush)webpush.setVapidDetails(process.env.VAPID_SUBJECT||process.env.BASE_URL||'https://loyalty.bunkwise.in',process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
// only real browser push services: the server POSTs to this URL, so anything else would let a shop make us call arbitrary hosts
const PUSH_HOST=/^https:\/\/([a-z0-9-]+\.)*(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//i;
async function notifyShop(shopId,payload){
  if(!webpush)return;const subs=await q('select endpoint,p256dh,auth from push_subs where shop_id=$1',[shopId]);
  await Promise.all(subs.map(s=>webpush.sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify(payload),{TTL:900,timeout:4000})
    .catch(e=>(e.statusCode===404||e.statusCode===410)&&q('delete from push_subs where endpoint=$1',[s.endpoint]))));
}

/* ================= CUSTOMER ================= */
const pubC=c=>({id:c.id,name:c.name,phone:c.phone,since:c.created_at});
const C=auth('customer');
const cleanName=s=>String(s||'').trim().replace(/\s+/g,' ').slice(0,60);
app.post('/api/auth/login',dbLimit('login',20,600),h(async(req,res)=>{
  const phone=normPhone(req.body.phone),name=cleanName(req.body.name);
  if(!phone)throw err(400,'Enter a valid 10-digit mobile number');
  if(!await verifyPhone(phone,req.body))throw err(401,'Verification failed');
  let c=await one('select * from customers where phone=$1',[phone]);
  // the PHONE NUMBER is the account. The name is just a label: new numbers need one, returning customers may leave it blank
  if(!c){if(name.length<2)throw err(400,'New here? Add your name to create your card.','NAME_REQUIRED');
    c=await one('insert into customers(phone,name) values($1,$2) on conflict(phone) do update set phone=excluded.phone returning *',[phone,name])}
  else if(c.status!=='active')throw err(403,'This number is blocked. Contact the shop.');
  else if(name.length>=2&&name!==c.name)c=await renameCustomer(c.id,name);
  startSession(res,'customer',c);res.json({customer:pubC(c)});
}));
// a new name must reach every shop's synced list, so the cards are touched too
const renameCustomer=(id,name)=>one('with k as(update cards set updated_at=now() where customer_id=$1) update customers set name=$2 where id=$1 returning *',[id,name]);
app.post('/api/auth/logout',(req,res)=>{clear(res,'customer');res.json({ok:true})});
app.patch('/api/me',C,h(async(req,res)=>{const name=cleanName(req.body.name);if(name.length<2)throw err(400,'Name is too short');res.json({customer:pubC(await renameCustomer(req.uid,name))})}));
// delete my account: name and number are erased; shops keep an anonymous record of rewards they gave
app.delete('/api/me',C,h(async(req,res)=>{
  await q(`with a as(update cards set removed_at=now(),updated_at=now() where customer_id=$1),
    b as(update stamp_requests set status='declined',decided_at=now() where customer_id=$1 and status='pending')
    update customers set status='deleted',phone=null,name='Deleted customer',token_ver=token_ver+1 where id=$1`,[req.uid]);
  clear(res,'customer');res.json({ok:true});
}));
// a shop can be found by its link slug, its short code, or a pasted link
const findShop=async key=>{key=String(key||'').trim();const m=key.match(/\/s\/([^/?#\s]+)/);if(m)key=m[1];
  return key&&key.length<=60?one("select * from shops where (slug=lower($1) or code=upper($1)) and status='active'",[key]):null};
// public, cached at the CDN for 5 minutes: QR scans by logged-out visitors cost almost nothing
app.get('/api/shop-public/:key',limit('lookup',60,6e5),h(async(req,res)=>{
  const s=await findShop(req.params.key);if(!s)throw err(404,'This QR code or shop code is not valid');
  res.set('Cache-Control','public, max-age=300, s-maxage=300').json({id:s.id,name:s.name,slug:s.slug,paused:s.paused,logo_ver:s.logo_ver});
}));
// logos: immutable per version (?v=logo_ver), so browsers and the CDN fetch each one once
app.get('/api/logo/:id(\\d{1,9})',h(async(req,res)=>{
  const l=await one('select type,img from shop_logos where shop_id=$1',[+req.params.id]);if(!l)return res.status(404).end();
  res.set('Cache-Control','public, max-age=31536000, immutable').type(l.type).send(l.img);
}));

async function decide(id,shopId,ok){
  // ONE statement: decide the request, add the stamp, give every reward reached or passed this cycle (once each),
  // complete the card at card_size, update the card counters and today's stats
  const r=await one(`with r as(update stamp_requests set status=$3,decided_at=now() where id=$1 and shop_id=$2 and status='pending' returning customer_id),
    s as(select card_size from shops where id=$2),
    k as(select k.stamps,k.cycles from cards k,r where k.customer_id=r.customer_id and k.shop_id=$2 and $3='approved'),
    cl as(insert into claims(reward_id,shop_id,customer_id,title,code,expires_at,cycle)
      select w.id,$2,r.customer_id,w.title,lpad(floor(random()*10000)::int::text,4,'0'),now()+w.expiry_days*interval '1 day',k.cycles
      from rewards w,r,k where w.shop_id=$2 and w.active and w.stamps_required<=k.stamps+1
      and not exists(select 1 from claims x where x.customer_id=r.customer_id and x.reward_id=w.id and x.cycle=k.cycles) returning 1),
    u as(update cards c set stamps=case when k.stamps+1>=s.card_size then 0 else k.stamps+1 end,cycles=c.cycles+(k.stamps+1>=s.card_size)::int,
      visits=c.visits+1,last_visit=now(),updated_at=now(),earned=c.earned+(select count(*) from cl)
      from r,k,s where c.customer_id=r.customer_id and c.shop_id=$2 returning 1),
    d as(insert into shop_days(shop_id,day,stamps,earned) select $2,${DAY},1,(select count(*) from cl) from u
      on conflict(shop_id,day) do update set stamps=shop_days.stamps+1,earned=shop_days.earned+excluded.earned returning 1)
    select r.customer_id,(select count(*) from cl)::int earned,(select count(*) from d)::int d from r`,[id,shopId,ok?'approved':'declined']);
  if(!r)throw err(404,'This request was already handled');return r;
}
const MAX_PER_HOUR=2,MAX_PER_DAY=20,COOLDOWN_MIN=10;
// Anti-fraud limits (one stamp a day, 2 an hour, 20 a day, cooldown after a decline) are OFF while testing.
// Turn them back on: set STAMP_LIMITS=on in the Vercel env vars and redeploy.
const LIMITS=process.env.STAMP_LIMITS==='on',stampLimit=LIMITS?limit('stamp',30,6e5,req=>req.uid):(req,res,next)=>next();
async function requestStamp(uid,s){
  if(s.paused)return 'paused';
  // ONE statement: join the shop (creates the card), then the anti-fraud checks, then the request
  const r=await one(`with cu as(select status from customers where id=$1),
    c as(insert into cards(customer_id,shop_id) select $1,$2 from cu where status='active'
      on conflict(customer_id,shop_id) do update set removed_at=null,updated_at=now() where cards.removed_at is not null returning (xmax=0) ins),
    nd as(insert into shop_days(shop_id,day,new_customers) select $2,${DAY},1 from c where ins on conflict(shop_id,day) do update set new_customers=shop_days.new_customers+1),
    chk as(select (select status from cu) cst,
      exists(select 1 from stamp_requests where customer_id=$1 and shop_id=$2 and status='pending') pending,
      ($3 and exists(select 1 from stamp_requests where customer_id=$1 and shop_id=$2 and status='approved' and decided_at>=${TODAY})) today,
      ($4 and exists(select 1 from stamp_requests where customer_id=$1 and shop_id=$2 and status='declined' and decided_at>now()-make_interval(mins=>${COOLDOWN_MIN}))) cooldown,
      ($4 and (select count(*) from stamp_requests where customer_id=$1 and shop_id=$2 and created_at>now()-interval '1 hour')>=${MAX_PER_HOUR}) hour_limit,
      ($4 and (select count(*) from stamp_requests where customer_id=$1 and created_at>now()-interval '1 day')>=${MAX_PER_DAY}) day_limit),
    ins as(insert into stamp_requests(customer_id,shop_id) select $1,$2 from chk
      where cst='active' and not(pending or today or cooldown or hour_limit or day_limit) on conflict do nothing returning id)
    select chk.*,(select id from ins) id from chk`,[uid,s.id,LIMITS&&!s.multi_per_day,LIMITS]);
  if(r.cst!=='active')throw err(403,'Your account is blocked.');
  if(!r.id)return r.today?'already_today':['cooldown','hour_limit','day_limit'].find(k=>r[k])||'pending';
  if(s.auto_approve){await decide(r.id,s.id,true);return 'approved'}
  await notifyShop(s.id,{t:'pending'}).catch(e=>console.error('push:',e.message));return 'pending';
}
// scan a QR link / enter a shop code: joins the shop and asks for a stamp
app.post('/api/scan/:key',C,stampLimit,h(async(req,res)=>{
  const s=await findShop(req.params.key);if(!s)throw err(404,'This QR code or shop code is not valid');
  res.json({status:await requestStamp(req.uid,s),shop_id:s.id});
}));
app.post('/api/cards/:shopId(\\d{1,9})/request',C,stampLimit,h(async(req,res)=>{
  const s=await one("select * from shops where id=$1 and status='active'",[+req.params.shopId]);if(!s)throw err(404,'Card not found');
  res.json({status:await requestStamp(req.uid,s),shop_id:s.id});
}));
// polled every few seconds while a request is waiting (and only then): one indexed row
app.get('/api/cards/:shopId(\\d{1,9})/status',C,h(async(req,res)=>{
  const r=await one('select status from stamp_requests where customer_id=$1 and shop_id=$2 order by id desc limit 1',[req.uid,+req.params.shopId]);
  res.json({status:r?.status||null});
}));
app.get('/api/home',C,h(async(req,res)=>{
  const [me,cards,rw,claims]=await Promise.all([
    one('select * from customers where id=$1',[req.uid]),
    q(`select s.id shop_id,s.name,s.slug,s.phone,s.address,s.hours,s.card_size,s.stamp_icon,s.paused,s.review_url,s.instagram,s.whatsapp,s.logo_ver,k.stamps,k.visits,
      exists(select 1 from stamp_requests r where r.customer_id=k.customer_id and r.shop_id=s.id and r.status='pending') pending
      from cards k join shops s on s.id=k.shop_id where k.customer_id=$1 and k.removed_at is null and s.status='active' order by coalesce(k.last_visit,k.created_at) desc`,[req.uid]),
    q('select shop_id,id,title,stamps_required,expiry_days from rewards where active and shop_id in(select shop_id from cards where customer_id=$1 and removed_at is null) order by stamps_required',[req.uid]),
    q("select id,reward_id,shop_id,title,code,expires_at from claims where customer_id=$1 and status='earned' and expires_at>now() order by earned_at",[req.uid])]);
  if(!me||me.status!=='active'){clear(res,'customer');throw err(401,'Please sign in')}
  cards.forEach(c=>{c.rewards=rw.filter(r=>r.shop_id===c.shop_id);c.claims=claims.filter(l=>l.shop_id===c.shop_id)});
  res.set('Cache-Control','private, no-cache').json({me:pubC(me),cards,claims,visits:cards.reduce((a,c)=>a+c.visits,0)});
}));
app.get('/api/rewards',C,h(async(req,res)=>res.json(await q(`select c.id,c.title,c.code,c.status,c.earned_at,c.expires_at,c.redeemed_at,s.name shop,
  (c.status='earned' and c.expires_at<=now()) expired from claims c join shops s on s.id=c.shop_id where c.customer_id=$1 order by c.earned_at desc limit 200`,[req.uid]))));

/* ================= SHOP ================= */
const SUPPORT=(process.env.SUPPORT_WHATSAPP||'').replace(/\D/g,'').replace(/^(?=\d{10}$)/,'91');
const scrypt=require('util').promisify(crypto.scrypt),PW_MAX=200; // async: never blocks other requests; max length: a 1 MB password burns CPU
const hashPw=async(p,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+(await scrypt(p,salt,64)).toString('hex');
const checkPw=async(p,st)=>{if(p.length>PW_MAX)return false;const[s,k]=st.split(':'),a=Buffer.from(k,'hex'),b=await scrypt(p,s,64);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const pwProblem=pw=>pw.length<8?'at least 8 characters':pw.length>PW_MAX?`at most ${PW_MAX} characters`:null;
const slugify=s=>(s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'shop')+'-'+crypto.randomBytes(2).toString('hex');
const genCode=()=>Array.from(crypto.randomBytes(6),b=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b%32]).join('');
const cleanEmail=s=>String(s||'').trim().toLowerCase().slice(0,200);
app.post('/api/shop/signup',dbLimit('signup',10,3600),h(async(req,res)=>{
  const name=String(req.body.name||'').trim().slice(0,80),email=cleanEmail(req.body.email),pw=String(req.body.password||'');
  if(name.length<2)throw err(400,'Enter your shop name');
  if(!/^\S+@\S+\.\S+$/.test(email))throw err(400,'Enter a valid email');
  if(pwProblem(pw))throw err(400,'Password must be '+pwProblem(pw));
  if(await one('select 1 from shops where email=$1',[email]))throw err(409,'This email is already registered');
  let s;for(let i=0;i<5&&!s;i++)try{s=await one('insert into shops(slug,code,name,email,pass_hash,phone) values($1,$2,$3,$4,$5,$6) returning id,token_ver',[slugify(name),genCode(),name,email,await hashPw(pw),normPhone(req.body.phone)])}catch(e){if(e.code!=='23505')throw e}
  if(!s)throw err(500,'Could not create shop, try again');
  startSession(res,'shop',s);res.json({ok:true});
}));
app.post('/api/shop/login',dbLimit('shop-login',15,600),dbLimit('shop-login-email',10,900,req=>cleanEmail(req.body.email)),h(async(req,res)=>{
  const s=await one('select id,pass_hash,token_ver,status from shops where email=$1',[cleanEmail(req.body.email)]);
  if(!s||!await checkPw(String(req.body.password||''),s.pass_hash))throw err(401,'Wrong email or password');
  if(s.status!=='active')throw err(403,'This shop account is suspended. Contact support.');
  startSession(res,'shop',s);res.json({ok:true});
}));
app.post('/api/shop/logout',(req,res)=>{clear(res,'shop');res.json({ok:true})});
// "Forgot password": the shop picks a NEW password, stored hashed in a pending request; the admin panel approves it
app.post('/api/shop/reset-request',dbLimit('reset',5,3600),h(async(req,res)=>{
  const email=cleanEmail(req.body.email),pw=String(req.body.password||'');
  if(!/^\S+@\S+\.\S+$/.test(email))throw err(400,'Enter your shop email');
  if(pwProblem(pw))throw err(400,'New password must be '+pwProblem(pw));
  const ref=String(crypto.randomInt(100000,1000000)),hash=await hashPw(pw),s=await one('select id,name,phone from shops where email=$1',[email]);
  // same answer whether or not the email exists, so nobody can probe which emails are registered
  if(s)await q('insert into password_resets(shop_id,ref,email,shop_name,shop_phone,new_pass_hash) values($1,$2,$3,$4,$5,$6)',[s.id,ref,email,s.name,s.phone,hash]);
  res.json({ok:true,code:'RST-'+ref,support:SUPPORT||null});
}));
const S=auth('shop');
const BASE=req=>process.env.BASE_URL||`${req.protocol}://${req.get('host')}`;
const ME='id,slug,code,name,email,phone,address,hours,card_size,stamp_icon,auto_approve,multi_per_day,plan,paused,status,review_url,instagram,whatsapp,logo_ver,created_at';
/* the dashboard keeps its own copy of customers and rewards given, and asks only for rows changed since its last sync.
   A quiet shop's poll returns almost nothing. c / l = cursors (last change seen); 5 s overlap covers transactions committing late */
app.get('/api/shop/sync',S,h(async(req,res)=>{
  // cursor = "time|id". Normal sync re-reads the last 5 s (catches slow commits); a "more" page (p=1) continues strictly after the cursor,
  // so thousands of rows with the same timestamp (e.g. after a migration) still page through
  const id=req.uid,full=req.query.full==='1',L=2000,page=req.query.p==='1',
    cur=v=>{const[t,i]=String(v||'').split('|'),d=new Date(t||0);return[isNaN(d)?new Date(0):d,+i||0]},
    after=(col,idc,v)=>{const[t,i]=cur(v);return page?[`(${col}.updated_at,${idc})>($2::timestamptz,$3::int)`,[t,i]]:[`${col}.updated_at>$2::timestamptz-interval '5 seconds'`,[t]]},
    [cw,cp]=after('k','k.customer_id',req.query.c),[lw,lp]=after('l','l.id',req.query.l);
  const [me,rewards,pending,cards,claims]=await Promise.all([
    full?one(`select ${ME} from shops where id=$1`,[id]):null,
    full?q('select id,title,stamps_required,expiry_days from rewards where shop_id=$1 and active order by stamps_required,id',[id]):null,
    q(`select r.id,r.created_at,r.customer_id,c.name,c.phone,k.stamps,k.visits from stamp_requests r join customers c on c.id=r.customer_id
      join cards k on k.customer_id=r.customer_id and k.shop_id=r.shop_id where r.shop_id=$1 and r.status='pending' order by r.created_at limit 200`,[id]),
    q(`select c.id,c.name,c.phone,k.stamps,k.visits,k.cycles,k.earned,k.redeemed,k.created_at joined,k.last_visit,k.updated_at u,k.removed_at is not null removed
      from cards k join customers c on c.id=k.customer_id where k.shop_id=$1 and ${cw} order by k.updated_at,k.customer_id limit ${L}`,[id,...cp]),
    q(`select id,customer_id,title,code,status,earned_at,expires_at,redeemed_at,updated_at u from claims l
      where shop_id=$1 and ${lw} order by updated_at,id limit ${L}`,[id,...lp])]);
  if(full){if(!me)throw err(401,'Please sign in');me.scan_url=`${BASE(req)}/s/${me.slug}`;me.vapid=webpush?process.env.VAPID_PUBLIC_KEY:null}
  const last=(a,c)=>a.length?new Date(a[a.length-1].u).toISOString()+'|'+a[a.length-1].id:c||null;
  res.set('Cache-Control','private, no-cache').json({me,rewards,pending,cards,claims,c:last(cards,req.query.c),l:last(claims,req.query.l),more:cards.length===L||claims.length===L});
}));
// overview charts: read from the per-day rollup, never from raw history
app.get('/api/shop/days',S,h(async(req,res)=>{
  const d=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null,from=d(req.query.from),to=d(req.query.to);if(!from||!to)throw err(400,'Pick a date range');
  if((new Date(to)-new Date(from))/864e5>400)throw err(400,'Pick a range of at most a year');
  res.set('Cache-Control','private, max-age=60').json(await q(`select to_char(day,'YYYY-MM-DD') AS day,stamps,new_customers,earned,redeemed from shop_days where shop_id=$1 and day between $2 and $3 order by day`,[req.uid,from,to]));
}));
// one customer's recent visits, loaded only when the shop opens that customer
app.get('/api/shop/customers/:id(\\d{1,9})',S,h(async(req,res)=>res.json(await q("select decided_at t from stamp_requests where customer_id=$1 and shop_id=$2 and status='approved' order by id desc limit 10",[+req.params.id,req.uid]))));
const STAMPS=['star','coffee','heart','flower','paw','scissors','pizza','burger','cake','icecream','tshirt','book'];
// the review button opens the shop's own Google page; only Google links are accepted so a shop cannot send customers elsewhere
const REVIEW=/^https:\/\/(g\.page|maps\.app\.goo\.gl|goo\.gl|g\.co|(www\.|maps\.|search\.)?google\.[a-z.]{2,6})\/\S*$/i;
app.patch('/api/shop/settings',S,h(async(req,res)=>{
  const b=req.body,str=(v,n)=>typeof v==='string'?v.trim().slice(0,n):null,bool=v=>typeof v==='boolean'?v:null;
  let rv=str(b.review_url,300),ig=str(b.instagram,100),wa=str(b.whatsapp,20);
  if(rv&&!REVIEW.test(rv))throw err(400,'Paste your Google review link (it starts with https://g.page or https://maps.app.goo.gl)');
  if(ig!=null){ig=ig.replace(/^https?:\/\/(www\.)?instagram\.com\//i,'').replace(/^@/,'').replace(/[/?#].*$/,'');if(ig&&!/^[A-Za-z0-9._]{1,30}$/.test(ig))throw err(400,'Enter your Instagram username')}
  if(wa!=null&&wa){const d=wa.replace(/\D/g,'');wa=normPhone(d)?'91'+normPhone(d):/^\d{11,15}$/.test(d)?d:null;if(!wa)throw err(400,'Enter a valid WhatsApp number')}
  await q(`update shops set name=coalesce($2,name),phone=coalesce($3,phone),address=coalesce($4,address),hours=coalesce($5,hours),card_size=coalesce($6::int,card_size), -- $6 unused: card size now follows the rewards
    auto_approve=coalesce($7,auto_approve),multi_per_day=coalesce($8,multi_per_day),stamp_icon=coalesce($9,stamp_icon),
    review_url=case when $10::text is null then review_url else nullif($10,'') end,instagram=case when $11::text is null then instagram else nullif($11,'') end,
    whatsapp=case when $12::text is null then whatsapp else nullif($12,'') end where id=$1`,
    [req.uid,str(b.name,80)||null,str(b.phone,20),str(b.address,200),str(b.hours,60),null,bool(b.auto_approve),bool(b.multi_per_day),STAMPS.includes(b.stamp_icon)?b.stamp_icon:null,rv,ig,wa]);
  res.json({ok:true});
}));
// pause switch: stops stamps, approvals and redemptions until the shop resumes. Waiting requests are closed
app.post('/api/shop/pause',S,h(async(req,res)=>{
  const p=req.body.paused===true;
  await q(`with a as(update stamp_requests set status='declined',decided_at=now() where shop_id=$1 and status='pending' and $2) update shops set paused=$2 where id=$1`,[req.uid,p]);
  res.json({ok:true,paused:p});
}));
// logo: the shop's browser shrinks it to a small WebP first, so the server only checks type and size (no image processing)
const IMG=[['image/webp',b=>b.length>12&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP'],['image/png',b=>b.slice(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],['image/jpeg',b=>b[0]===255&&b[1]===216&&b[2]===255]];
app.put('/api/shop/logo',S,limit('logo',20,864e5,req=>req.uid),express.raw({type:()=>true,limit:'60kb'}),h(async(req,res)=>{
  const b=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0),t=IMG.find(([,ok])=>ok(b));if(!t)throw err(400,'Use a JPG, PNG or WebP image');
  const r=await one(`with l as(insert into shop_logos values($1,$2,$3) on conflict(shop_id) do update set type=excluded.type,img=excluded.img)
    update shops set logo_ver=logo_ver+1 where id=$1 returning logo_ver`,[req.uid,t[0],b]);
  res.json({logo_ver:r.logo_ver});
}));
app.delete('/api/shop/logo',S,h(async(req,res)=>{await q('with l as(delete from shop_logos where shop_id=$1) update shops set logo_ver=0 where id=$1',[req.uid]);res.json({ok:true})}));
app.post('/api/shop/requests/:id(\\d{1,9})/:act(approve|decline)',S,h(async(req,res)=>{await decide(+req.params.id,req.uid,req.params.act==='approve');res.json({ok:true})}));
app.post('/api/shop/requests/approve-all',S,h(async(req,res)=>{
  const ids=await q("select id from stamp_requests where shop_id=$1 and status='pending' order by id limit 200",[req.uid]);let n=0;
  for(const r of ids)await decide(r.id,req.uid,true).then(()=>n++,()=>{});res.json({approved:n});
}));
async function rewardBody(req){
  const title=String(req.body.title||'').trim().slice(0,80),n=Math.floor(+req.body.stamps_required),d=Math.floor(+req.body.expiry_days)||30;
  if(title.length<2)throw err(400,'Describe the reward');
  if(!(n>=1&&n<=30))throw err(400,'Stamps required must be between 1 and 30');
  if(!(d>=1&&d<=365))throw err(400,'Expiry must be 1 to 365 days');
  return [title,n,d];
}
// the card always has as many stamps as the biggest active reward
const fitCard=id=>q('update shops set card_size=coalesce((select max(stamps_required) from rewards where shop_id=$1 and active),card_size) where id=$1',[id]);
app.post('/api/shop/rewards',S,h(async(req,res)=>{await q('insert into rewards(shop_id,title,stamps_required,expiry_days) values($1,$2,$3,$4)',[req.uid,...await rewardBody(req)]);await fitCard(req.uid);res.json({ok:true})}));
app.patch('/api/shop/rewards/:id(\\d{1,9})',S,h(async(req,res)=>{await q('update rewards set title=$3,stamps_required=$4,expiry_days=$5 where id=$1 and shop_id=$2',[+req.params.id,req.uid,...await rewardBody(req)]);await fitCard(req.uid);res.json({ok:true})}));
app.delete('/api/shop/rewards/:id(\\d{1,9})',S,h(async(req,res)=>{await q('update rewards set active=false where id=$1 and shop_id=$2',[+req.params.id,req.uid]);await fitCard(req.uid);res.json({ok:true})}));
// redeem by tapping in the list, or by scanning the customer's reward QR (which carries the code as a check)
app.post('/api/shop/claims/:id(\\d{1,9})/redeem',S,h(async(req,res)=>{
  const code=req.body&&typeof req.body.code==='string'?req.body.code:null;
  const r=await one(`with l as(update claims set status='redeemed',redeemed_at=now(),updated_at=now() where id=$1 and shop_id=$2 and status='earned' and expires_at>now()
      and ($3::text is null or code=$3) and exists(select 1 from shops where id=$2 and not paused) returning customer_id),
    k as(update cards set redeemed=redeemed+1,updated_at=now() from l where cards.customer_id=l.customer_id and cards.shop_id=$2),
    d as(insert into shop_days(shop_id,day,redeemed) select $2,${DAY},1 from l on conflict(shop_id,day) do update set redeemed=shop_days.redeemed+1)
    select customer_id from l`,[+req.params.id,req.uid,code]);
  if(!r)throw err(404,'Reward not available (already redeemed, expired, or the program is paused)');res.json({ok:true});
}));
// add one or many customers (typed in, or from a CSV/Excel list): creates their cards automatically
app.post('/api/shop/customers/import',S,limit('import',30,36e5,req=>req.uid),h(async(req,res)=>{
  const rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)throw err(400,'No customers to add');if(rows.length>2000)throw err(400,'Please import 2000 customers or fewer at a time');
  const sh=await one('select card_size from shops where id=$1',[req.uid]),seen=new Set(),ok=[],bad=[];
  rows.forEach((r,i)=>{const p=normPhone(r.phone),n=cleanName(r.name)||'Customer',st=Math.min(Math.max(parseInt(r.stamps)||0,0),sh.card_size-1);
    if(!p)bad.push({row:r.row||i+1,reason:'Invalid mobile number'});else if(seen.has(p))bad.push({row:r.row||i+1,reason:'Duplicate number in the list'});else{seen.add(p);ok.push([p,n,st])}});
  if(!ok.length)return res.json({total:rows.length,cards_added:0,already:0,invalid:bad});
  const r=await one(`with input as(select * from unnest($1::text[],$2::text[],$3::int[]) as t(phone,name,stamps)),
    ins as(insert into customers(phone,name) select phone,name from input on conflict(phone) do nothing returning id,phone),
    allc as(select id,phone from ins union select c.id,c.phone from customers c join input i on i.phone=c.phone where c.status='active'),
    cd as(insert into cards(customer_id,shop_id,stamps,visits) select a.id,$4,i.stamps,i.stamps from allc a join input i on i.phone=a.phone
      on conflict(customer_id,shop_id) do update set removed_at=null,stamps=excluded.stamps,updated_at=now() where cards.removed_at is not null returning customer_id),
    nd as(insert into shop_days(shop_id,day,new_customers) select $4,${DAY},count(*) from cd having count(*)>0
      on conflict(shop_id,day) do update set new_customers=shop_days.new_customers+excluded.new_customers)
    select (select count(*) from cd)::int cards_added`,[ok.map(x=>x[0]),ok.map(x=>x[1]),ok.map(x=>x[2]),req.uid]);
  // whether a number already used the app is NOT returned: that would leak other shops' customers
  res.json({total:rows.length,cards_added:r.cards_added,already:ok.length-r.cards_added,invalid:bad});
}));
// remove = hide the card and clear its stamps. Rewards already given stay in the shop's history
app.delete('/api/shop/customers/:id(\\d{1,9})',S,h(async(req,res)=>{
  await q(`with a as(update stamp_requests set status='declined',decided_at=now() where customer_id=$1 and shop_id=$2 and status='pending')
    update cards set removed_at=now(),stamps=0,updated_at=now() where customer_id=$1 and shop_id=$2`,[+req.params.id,req.uid]);
  res.json({ok:true});
}));
/* ---- account ---- */
const reauth=async(req)=>{const s=await one('select * from shops where id=$1',[req.uid]);if(!await checkPw(String(req.body.current||''),s.pass_hash))throw err(401,'Current password is wrong');return s};
app.post('/api/shop/password',S,limit('acct',10,9e5,req=>req.uid),h(async(req,res)=>{
  await reauth(req);const pw=String(req.body.password||'');if(pwProblem(pw))throw err(400,'New password must be '+pwProblem(pw));
  // bumping token_ver signs out every other device; this one gets a fresh cookie
  startSession(res,'shop',await one('update shops set pass_hash=$2,token_ver=token_ver+1 where id=$1 returning id,token_ver',[req.uid,await hashPw(pw)]));res.json({ok:true});
}));
app.post('/api/shop/email',S,limit('acct',10,9e5,req=>req.uid),h(async(req,res)=>{
  await reauth(req);const email=cleanEmail(req.body.email);if(!/^\S+@\S+\.\S+$/.test(email))throw err(400,'Enter a valid email');
  try{await q('update shops set email=$2 where id=$1',[req.uid,email])}catch(e){if(e.code==='23505')throw err(409,'This email is already registered');throw e}
  res.json({ok:true});
}));
app.post('/api/shop/logout-all',S,h(async(req,res)=>{startSession(res,'shop',await one('update shops set token_ver=token_ver+1 where id=$1 returning id,token_ver',[req.uid]));res.json({ok:true})}));
app.post('/api/shop/push',S,limit('push',20,36e5,req=>req.uid),h(async(req,res)=>{
  const b=req.body||{},e=String(b.endpoint||''),k=b.keys||{};
  if(!webpush||e.length>800||!PUSH_HOST.test(e)||!/^[\w-]{20,200}$/.test(k.p256dh||'')||!/^[\w-]{8,100}$/.test(k.auth||''))throw err(400,'Notifications are not available');
  await q(`with a as(insert into push_subs(endpoint,shop_id,p256dh,auth) values($1,$2,$3,$4) on conflict(endpoint) do update set shop_id=$2,p256dh=$3,auth=$4)
    delete from push_subs where shop_id=$2 and endpoint<>$1 and endpoint not in(select endpoint from push_subs where shop_id=$2 order by created_at desc limit 9)`,[e,req.uid,k.p256dh,k.auth]);
  res.json({ok:true});
}));

/* ---- daily housekeeping (Vercel Cron calls this once a day; any other scheduler can too) ---- */
app.get('/api/cron/daily',h(async(req,res)=>{
  if(!process.env.CRON_SECRET||req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).end();
  await q(`delete from rate_limits where reset_at<now()`);
  await q(`update password_resets set status='expired',resolved_at=now() where status='pending' and requested_at<now()-interval '2 days'`);
  await q(`delete from stamp_requests where status='declined' and decided_at<now()-interval '180 days'`);
  res.json({ok:true});
}));

/* ================= PAGES (on Vercel these are served by the CDN, see vercel.json) ================= */
const pub=f=>(q,r)=>r.sendFile(path.join(__dirname,'public',f));
app.get('/healthz',(q,r)=>r.send('ok'));
app.get(['/','/s/:slug'],pub('customer.html'));app.get('/shop',pub('shop.html'));app.get('/privacy',pub('privacy.html'));
app.use(express.static(path.join(__dirname,'public'),{maxAge:PROD?'1h':0}));
app.use('/api',(q,r)=>r.status(404).json({error:'Not found'}));
app.use((e,req,res,next)=>{if(e.type==='entity.too.large')e=err(413,'That file is too large');if(!e.status)console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Server error. Please try again.',code:e.code})});
if(PROD&&!process.env.BASE_URL)console.warn('BASE_URL is not set: QR codes will use whatever host the request came in on');
module.exports=app;

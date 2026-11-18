/* Stampwise adapter. An adapter tells the admin panel what it can list, show and do for one project.
   Shape (copy it for the next project):
   { entities:{ key:{ label, cols:[[field,label,type]], filters:[[value,label]], list(q,{search,filter,offset}), get(q,id), actions:{ key:{label,role,danger,reason,input,when,run(q,id,{reason,value})} } } },
     stats(q), system(q) }
   q(sql,params) -> rows. role = the minimum admin role (viewer < support < owner). when = [field,value]: only shown when the row matches. */
const LIMIT=50;
const mask=p=>p?p.slice(0,5)+'•••'+p.slice(8):'';
const like=s=>'%'+s.replace(/[\\%_]/g,'\\$&')+'%';
const page=async(q,sql,params,offset)=>{const rows=await q(sql+` limit ${LIMIT+1} offset ${+offset||0}`,params);return{rows:rows.slice(0,LIMIT),more:rows.length>LIMIT}};
const need=(rows,msg='Nothing changed: it was already handled or no longer exists')=>{if(!rows.length)throw Object.assign(new Error(msg),{status:409});return rows[0]};

const shops={
  label:'Shops',
  cols:[['id','ID','num'],['name','Shop'],['email','Email'],['phone','Phone'],['code','Code','mono'],['status','Status','tag'],['customers','Customers','num'],['last_active','Last stamp','date'],['created_at','Joined','date']],
  filters:[['','All'],['active','Active'],['suspended','Suspended'],['paused','Paused'],['auto','Auto-approve on']],
  list:(q,{search,filter,offset})=>page(q,`select s.id,s.name,s.email,s.phone,s.code,
      case when s.status<>'active' then s.status when s.paused then 'paused' else 'active' end status,
      (select count(*) from cards k where k.shop_id=s.id and k.removed_at is null)::int customers,
      (select max(day) from shop_days d where d.shop_id=s.id and d.stamps>0) last_active,s.created_at
    from shops s where ($1='' or s.name ilike $2 or s.email ilike $2 or s.phone like $2 or s.code=upper($1) or s.id::text=$1)
      and ($3='' or s.status=$3 or ($3='paused' and s.paused) or ($3='auto' and s.auto_approve)) order by s.id desc`,[search,like(search),filter],offset),
  // read-only "view as shop": everything the shop sees, without creating a shop session
  async get(q,id){
    const[s]=await q(`select id,name,slug,code,email,phone,address,hours,plan,status,status_reason,paused,auto_approve,multi_per_day,card_size,stamp_icon,review_url,instagram,whatsapp,created_at,
      (select count(*) from cards k where k.shop_id=$1 and k.removed_at is null)::int customers,
      (select count(*) from stamp_requests r where r.shop_id=$1 and r.status='pending')::int pending,
      (select count(*) from shop_staff t where t.shop_id=$1)::int staff from shops where id=$1`,[id]);
    if(!s)return null;
    const[rewards,days,reqs,resets]=await Promise.all([
      q('select title,stamps_required,expiry_days,active from rewards where shop_id=$1 order by active desc,stamps_required',[id]),
      q('select day,stamps,new_customers,earned,redeemed from shop_days where shop_id=$1 order by day desc limit 30',[id]),
      q(`select r.id,r.created_at,r.status,r.decided_at,c.id customer_id,c.name,c.phone from stamp_requests r left join customers c on c.id=r.customer_id where r.shop_id=$1 order by r.id desc limit 50`,[id]),
      q('select ref,status,requested_at,resolved_at from password_resets where shop_id=$1 order by id desc limit 10',[id])]);
    reqs.forEach(r=>r.phone=mask(r.phone));
    return{title:s.name,row:s,fields:s,sections:[
      {title:'Rewards',cols:[['title','Reward'],['stamps_required','Stamps','num'],['expiry_days','Valid days','num'],['active','Active','bool']],rows:rewards},
      {title:'Last 30 active days',cols:[['day','Day','date'],['stamps','Stamps','num'],['new_customers','New customers','num'],['earned','Rewards earned','num'],['redeemed','Redeemed','num']],rows:days},
      {title:'Last 50 stamp requests',cols:[['created_at','When','time'],['name','Customer','link:customers:customer_id'],['phone','Phone'],['status','Status','tag'],['decided_at','Decided','time']],rows:reqs},
      {title:'Password resets',cols:[['ref','Ref','mono'],['status','Status','tag'],['requested_at','Requested','time'],['resolved_at','Resolved','time']],rows:resets}]};
  },
  actions:{
    suspend:{label:'Suspend shop',role:'support',danger:1,reason:1,when:['status','active'],
      run:async(q,id,{reason})=>need(await q(`with d as(update stamp_requests set status='declined',decided_at=now() where shop_id=$1 and status='pending')
        update shops set status='suspended',status_reason=$2,token_ver=token_ver+1 where id=$1 and status='active' returning id`,[id,reason]))},
    reactivate:{label:'Reactivate',role:'support',reason:1,when:['status','suspended'],
      run:async(q,id)=>need(await q(`update shops set status='active',status_reason=null where id=$1 and status='suspended' returning id`,[id]))},
    logout_all:{label:'Log out all devices',role:'support',reason:1,
      run:async(q,id)=>need(await q('update shops set token_ver=token_ver+1 where id=$1 returning id',[id]))},
    set_plan:{label:'Change plan',role:'owner',reason:1,input:{label:'New plan (e.g. free, pro)',pattern:'^[a-z0-9_-]{1,20}$'},
      run:async(q,id,{value})=>need(await q('update shops set plan=$2 where id=$1 returning id,plan',[id,value]))},
  }};

const customers={
  label:'Customers',
  cols:[['id','ID','num'],['name','Name'],['phone','Phone'],['status','Status','tag'],['cards','Cards','num'],['created_at','Joined','date']],
  filters:[['','All'],['active','Active'],['blocked','Blocked'],['deleted','Deleted']],
  list:async(q,{search,filter,offset})=>{const r=await page(q,`select c.id,c.name,c.phone,c.status,c.created_at,
      (select count(*) from cards k where k.customer_id=c.id and k.removed_at is null)::int cards
    from customers c where ($1='' or c.name ilike $2 or c.phone like $2 or c.id::text=$1) and ($3='' or c.status=$3) order by c.id desc`,[search,like(search),filter],offset);
    r.rows.forEach(c=>c.phone=mask(c.phone));return r},
  async get(q,id){
    const[c]=await q('select id,name,phone,phone_verified,status,created_at from customers where id=$1',[id]);if(!c)return null;
    const[cards,claims,reqs]=await Promise.all([
      q(`select s.id shop_id,s.name shop,k.stamps,s.card_size,k.visits,k.cycles,k.earned,k.redeemed,k.last_visit,k.removed_at from cards k join shops s on s.id=k.shop_id where k.customer_id=$1 order by k.last_visit desc nulls last`,[id]),
      q(`select l.title,s.name shop,l.code,l.status,l.earned_at,l.expires_at,l.redeemed_at from claims l join shops s on s.id=l.shop_id where l.customer_id=$1 order by l.id desc limit 50`,[id]),
      q(`select r.created_at,s.id shop_id,s.name shop,r.status from stamp_requests r join shops s on s.id=r.shop_id where r.customer_id=$1 order by r.id desc limit 50`,[id])]);
    return{title:c.name,row:c,fields:c,audit:'view customer',sections:[
      {title:'Cards',cols:[['shop','Shop','link:shops:shop_id'],['stamps','Stamps','num'],['visits','Visits','num'],['cycles','Cards done','num'],['earned','Earned','num'],['redeemed','Redeemed','num'],['last_visit','Last visit','time'],['removed_at','Removed','date']],rows:cards},
      {title:'Rewards',cols:[['title','Reward'],['shop','Shop'],['code','Code','mono'],['status','Status','tag'],['earned_at','Earned','date'],['expires_at','Expires','date'],['redeemed_at','Redeemed','date']],rows:claims},
      {title:'Last 50 stamp requests',cols:[['created_at','When','time'],['shop','Shop','link:shops:shop_id'],['status','Status','tag']],rows:reqs}]};
  },
  actions:{
    block:{label:'Block',role:'support',danger:1,reason:1,when:['status','active'],
      run:async(q,id)=>need(await q(`with d as(update stamp_requests set status='declined',decided_at=now() where customer_id=$1 and status='pending')
        update customers set status='blocked',token_ver=token_ver+1 where id=$1 and status='active' returning id`,[id]))},
    unblock:{label:'Unblock',role:'support',reason:1,when:['status','blocked'],
      run:async(q,id)=>need(await q(`update customers set status='active' where id=$1 and status='blocked' returning id`,[id]))},
    rename:{label:'Edit name',role:'support',reason:1,input:{label:'New name',pattern:'^.{2,60}$'},when:['status','active'],
      run:async(q,id,{value})=>{const r=need(await q(`update customers set name=$2 where id=$1 returning id`,[id,value.trim().replace(/\s+/g,' ')]));
        await q('update cards set updated_at=now() where customer_id=$1',[id]);return r}},
    logout_all:{label:'Log out all devices',role:'support',reason:1,
      run:async(q,id)=>need(await q('update customers set token_ver=token_ver+1 where id=$1 returning id',[id]))},
    // DPDP erasure: same as the customer's own "Delete my account". Shops keep anonymous reward history.
    erase:{label:'Delete (erase personal data)',role:'owner',danger:1,reason:1,confirm:'DELETE',
      run:async(q,id)=>need(await q(`with a as(update cards set removed_at=now(),updated_at=now() where customer_id=$1),
        b as(update stamp_requests set status='declined',decided_at=now() where customer_id=$1 and status='pending')
        update customers set status='deleted',phone=null,name='Deleted customer',token_ver=token_ver+1 where id=$1 and status<>'deleted' returning id`,[id]))},
  }};

const resets={
  label:'Password resets',
  cols:[['id','ID','num'],['ref','Ref','mono'],['shop_name','Shop','link:shops:shop_id'],['email','Email'],['shop_phone','Registered phone'],['recent','Requests (30 days)','num'],['status','Status','tag'],['requested_at','Requested','time']],
  filters:[['pending','Pending'],['','All'],['done','Approved'],['rejected','Rejected'],['expired','Expired']],
  list:(q,{search,filter,offset})=>page(q,`select r.id,'RST-'||r.ref ref,r.shop_id,r.shop_name,r.email,r.shop_phone,r.status,r.requested_at,
      (select count(*) from password_resets x where x.shop_id=r.shop_id and x.requested_at>now()-interval '30 days')::int recent
    from password_resets r where ($1='' or r.ref=regexp_replace($1,'\\D','','g') or r.email ilike $2 or r.shop_name ilike $2) and ($3='' or r.status=$3) order by r.id desc`,[search,like(search),filter],offset),
  async get(q,id){const[r]=await q(`select id,'RST-'||ref ref,shop_id,shop_name,email,shop_phone,status,requested_at,resolved_at from password_resets where id=$1`,[id]);
    return r&&{title:r.ref+' · '+r.shop_name,row:r,fields:r,sections:[]}},
  actions:{
    // check first: the WhatsApp message came from the shop's registered phone and quotes this ref
    approve:{label:'Approve: set the new password',role:'support',reason:1,when:['status','pending'],
      run:async(q,id)=>need(await q(`with r as(update password_resets set status='done',resolved_at=now() where id=$1 and status='pending' and requested_at>now()-interval '2 days' returning shop_id,new_pass_hash),
        o as(update password_resets set status='expired',resolved_at=now() where shop_id=(select shop_id from r) and status='pending' and id<>$1)
        update shops s set pass_hash=r.new_pass_hash,token_ver=token_ver+1 from r where s.id=r.shop_id returning s.id`,[id]),'Already handled or older than 2 days')},
    reject:{label:'Reject',role:'support',reason:1,when:['status','pending'],
      run:async(q,id)=>need(await q(`update password_resets set status='rejected',resolved_at=now() where id=$1 and status='pending' returning id`,[id]))},
  }};

module.exports={
  entities:{shops,customers,resets},
  async stats(q){
    const[[t],days,top,flags]=await Promise.all([
      q(`select (select count(*) from shops)::int shops,(select count(*) from shops where status='suspended')::int suspended,(select count(*) from shops where paused)::int paused,
        (select count(*) from customers where status='active')::int customers,(select count(*) from cards where removed_at is null)::int cards,
        (select count(*) from password_resets where status='pending')::int resets,
        (select count(distinct shop_id) from shop_days where day>current_date-7 and stamps>0)::int active7,
        (select count(distinct shop_id) from shop_days where day>current_date-30 and stamps>0)::int active30`),
      q(`select day,sum(stamps)::int stamps,sum(new_customers)::int new_customers,sum(earned)::int earned,sum(redeemed)::int redeemed from shop_days where day>current_date-30 group by day order by day`),
      q(`select s.id,s.name,sum(d.stamps)::int stamps,sum(d.new_customers)::int new_customers from shop_days d join shops s on s.id=d.shop_id where d.day>current_date-30 group by s.id,s.name order by 3 desc limit 10`),
      // cheap abuse signals: auto-approve shops with a very busy day, customers joining many shops in a day
      q(`select 'shop' kind,s.id,s.name label,'Auto-approve and '||max(d.stamps)||' stamps in one day' why from shops s join shop_days d on d.shop_id=s.id
          where s.auto_approve and d.day>current_date-7 and d.stamps>150 group by s.id,s.name
        union all select 'customer',c.id,c.name,count(*)||' shops joined in 24 hours' from cards k join customers c on c.id=k.customer_id
          where k.created_at>now()-interval '1 day' group by c.id,c.name having count(*)>=5 limit 50`)]);
    return{totals:t,days,top,flags};
  },
  async system(q){
    const[[db],mig,tables]=await Promise.all([q('select pg_size_pretty(pg_database_size(current_database())) size,version()'),
      q('select name,applied_at from schema_migrations order by name'),q(`select relname tbl,n_live_tup::int rows_est from pg_stat_user_tables where schemaname='public' order by n_live_tup desc`)]);
    return{db,migrations:mig,tables};
  },
};

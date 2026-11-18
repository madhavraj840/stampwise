require('dotenv').config();
// Runs admin/migrations/*.sql once each, in order, recorded in admin.schema_migrations (separate from the projects' own migrations).
const {Client}=require('pg'),fs=require('fs'),path=require('path');
const url=process.env.ADMIN_DATABASE_URL_UNPOOLED||process.env.ADMIN_DATABASE_URL||process.env.STAMPWISE_DATABASE_URL_UNPOOLED||process.env.STAMPWISE_DATABASE_URL;
(async()=>{
  if(!url)throw new Error('Set STAMPWISE_DATABASE_URL (or ADMIN_DATABASE_URL)');
  const c=new Client({connectionString:url});await c.connect();
  try{
    await c.query('select pg_advisory_lock(727002)');
    await c.query('create schema if not exists admin; create table if not exists admin.schema_migrations(name text primary key, applied_at timestamptz not null default now())');
    const done=new Set((await c.query('select name from admin.schema_migrations')).rows.map(r=>r.name)),dir=path.join(__dirname,'migrations');
    for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
      if(done.has(f))continue;
      try{await c.query('begin');await c.query(fs.readFileSync(path.join(dir,f),'utf8'));await c.query('insert into admin.schema_migrations(name) values($1)',[f]);await c.query('commit');console.log('applied',f)}
      catch(e){await c.query('rollback');throw new Error(f+': '+e.message)}
    }
    console.log('Admin schema ready');
  }finally{await c.end()}
})().catch(e=>{console.error(e.message);process.exit(1)});

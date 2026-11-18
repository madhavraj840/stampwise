require('dotenv').config();
const {Client}=require('pg'),fs=require('fs'),path=require('path');
// Runs each migrations/NNN_name.sql once, in name order, each inside a transaction, and records it in schema_migrations.
// Never edit a file that has already run anywhere: add a new numbered file instead.
// (CREATE INDEX CONCURRENTLY cannot run in a transaction: put it in its own file and run it by hand on big tables.)
(async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL});await c.connect();
  try{
    await c.query('select pg_advisory_lock(727001)'); // two deploys migrating at once wait for each other
    await c.query('create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())');
    const done=new Set((await c.query('select name from schema_migrations')).rows.map(r=>r.name)),dir=path.join(__dirname,'migrations');
    for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){
      if(done.has(f))continue;
      try{await c.query('begin');await c.query(fs.readFileSync(path.join(dir,f),'utf8'));await c.query('insert into schema_migrations(name) values($1)',[f]);await c.query('commit');console.log('applied',f)}
      catch(e){await c.query('rollback');throw new Error(f+': '+e.message)}
    }
    console.log('Schema ready');
  }finally{await c.end()}
})().catch(e=>{console.error(e.message);process.exit(1)});

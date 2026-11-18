// First owner (or a lost-access recovery): node scripts/create-admin.js you@example.com [owner|support|viewer]
// Prints a one-time password and the authenticator secret. Run it from your own computer with the admin env vars set.
require('dotenv').config({path:require('path').join(__dirname,'..','.env')});
const {Client}=require('pg'),{hashPw,newTotp,randPw}=require('../lib');
(async()=>{
  const[email,role='owner']=process.argv.slice(2);
  if(!/^\S+@\S+\.\S+$/.test(email||'')||!['owner','support','viewer'].includes(role))throw new Error('Usage: node scripts/create-admin.js you@example.com [owner|support|viewer]');
  const c=new Client({connectionString:process.env.ADMIN_DATABASE_URL||process.env.STAMPWISE_DATABASE_URL});await c.connect();
  const pw=randPw(),t=newTotp(email.toLowerCase());
  // existing email = reset its password and 2FA (recovery when the authenticator phone is lost)
  await c.query(`insert into admin.admin_users(email,pass_hash,totp_secret,role) values($1,$2,$3,$4)
    on conflict(email) do update set pass_hash=$2,totp_secret=$3,totp_last=0,role=$4,disabled=false,fails=0,locked_until=null,token_ver=admin.admin_users.token_ver+1`,[email.toLowerCase(),await hashPw(pw),t.stored,role]);
  await c.query(`insert into admin.audit_log(admin_email,action,target,detail) values('cli','create admin (script)',$1,$2)`,[email.toLowerCase(),JSON.stringify({role})]);
  await c.end();
  console.log(`\nAdmin ready: ${email} (${role})\nPassword: ${pw}\nAuthenticator secret: ${t.secret}\n(or add this link as a QR in your authenticator: ${t.uri})\nChange the password after the first login.\n`);
})().catch(e=>{console.error(e.message);process.exit(1)});

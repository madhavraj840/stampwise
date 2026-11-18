// Shared by the admin server and scripts/create-admin.js. Node crypto only: password hashing, TOTP (RFC 6238), secret encryption.
const crypto=require('crypto'),scrypt=require('util').promisify(crypto.scrypt);
const SECRET=process.env.ADMIN_SECRET;
if(!SECRET||SECRET.length<32)throw new Error('ADMIN_SECRET must be set (32+ random characters). Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
const KEY=crypto.createHash('sha256').update('admin-key:'+SECRET).digest();

const hashPw=async(p,salt=crypto.randomBytes(16).toString('hex'))=>salt+':'+(await scrypt(p,salt,64)).toString('hex');
const checkPw=async(p,st)=>{if(!st||p.length>200)return false;const[s,k]=st.split(':'),a=Buffer.from(k,'hex'),b=await scrypt(p,s,64);return a.length===b.length&&crypto.timingSafeEqual(a,b)};

// TOTP secrets are stored encrypted, so a leaked database alone cannot generate codes
const enc=t=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',KEY,iv),x=Buffer.concat([c.update(t,'utf8'),c.final()]);return[iv,c.getAuthTag(),x].map(b=>b.toString('base64url')).join('.')};
const dec=s=>{const[iv,tag,x]=s.split('.').map(b=>Buffer.from(b,'base64url')),d=crypto.createDecipheriv('aes-256-gcm',KEY,iv);d.setAuthTag(tag);return Buffer.concat([d.update(x),d.final()]).toString('utf8')};

const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32=buf=>{let bits='',out='';for(const b of buf)bits+=b.toString(2).padStart(8,'0');for(let i=0;i+5<=bits.length;i+=5)out+=B32[parseInt(bits.slice(i,i+5),2)];return out};
const unb32=s=>{let bits='';for(const c of s.toUpperCase().replace(/[^A-Z2-7]/g,''))bits+=B32.indexOf(c).toString(2).padStart(5,'0');const o=[];for(let i=0;i+8<=bits.length;i+=8)o.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(o)};
const hotp=(key,n)=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));const h=crypto.createHmac('sha1',key).update(b).digest(),o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0')};
const newTotp=email=>{const secret=b32(crypto.randomBytes(20));return{secret,stored:enc(secret),uri:`otpauth://totp/${encodeURIComponent('Bunkwise Admin:'+email)}?secret=${secret}&issuer=${encodeURIComponent('Bunkwise Admin')}`}};
// returns the time step that matched (to refuse reusing a code), or 0. Allows one step of clock drift either way.
const checkTotp=(stored,code,last=0)=>{if(!/^\d{6}$/.test(code||''))return 0;const key=unb32(dec(stored)),now=Math.floor(Date.now()/3e4);
  for(const n of[now,now-1,now+1])if(n>last&&crypto.timingSafeEqual(Buffer.from(hotp(key,n)),Buffer.from(code)))return n;return 0};

const sign=s=>crypto.createHmac('sha256',KEY).update(s).digest('base64url');
const randPw=()=>crypto.randomBytes(12).toString('base64url');
module.exports={hashPw,checkPw,newTotp,checkTotp,hotp,unb32,sign,randPw};

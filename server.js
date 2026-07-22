const express=require('express');
const helmet=require('helmet');
const {rateLimit}=require('express-rate-limit');
const crypto=require('crypto');

const VERSION='4.2.0';
const url=process.env.TURSO_DATABASE_URL;
const authToken=process.env.TURSO_AUTH_TOKEN;
const secret=process.env.DB_SERVER_SECRET;
if(!url||!authToken||!secret){console.error('TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and DB_SERVER_SECRET are required.');process.exit(1)}
const httpBase=url.replace(/^libsql:/,'https:').replace(/\/$/,'');
async function pipeline(requests){
 const response=await fetch(`${httpBase}/v2/pipeline`,{method:'POST',headers:{authorization:`Bearer ${authToken}`,'content-type':'application/json'},body:JSON.stringify({requests:[...requests,{type:'close'}]})});
 if(!response.ok)throw new Error(`Turso HTTP ${response.status}: ${await response.text()}`);
 const body=await response.json();
 const results=[];
 for(const item of body.results||[]){if(item.type==='error')throw new Error(item.error?.message||'Turso query failed');if(item.type==='ok')results.push(item.response)}
 return results;
}
function value(v){if(v===null||v===undefined)return {type:'null'};if(typeof v==='number')return Number.isInteger(v)?{type:'integer',value:String(v)}:{type:'float',value:v};return {type:'text',value:String(v)}}
async function execute(sql,args=[]){if(sql&&typeof sql==='object'){args=sql.args||[];sql=sql.sql}const [r]=await pipeline([{type:'execute',stmt:{sql,args:args.map(value),named_args:[],want_rows:true}}]);const cols=(r.result?.cols||[]).map(c=>c.name);const rows=(r.result?.rows||[]).map(row=>Object.fromEntries(row.map((v,i)=>[cols[i],v.type==='null'?null:(v.type==='integer'?Number(v.value):v.value)])));return {rows};}
async function executeMultiple(sql){for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await execute(statement)}
const db={execute,executeMultiple};
const app=express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(rateLimit({windowMs:15*60*1000,limit:1000,standardHeaders:'draft-8',legacyHeaders:false}));
app.use(express.json({limit:process.env.MAX_SNAPSHOT_JSON||'40mb'}));
function safeEqual(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function auth(req,res,next){if(!safeEqual(req.get('x-fbm-secret'),secret))return res.status(401).json({error:'Unauthorized'});next()}
function sha256(b){return crypto.createHash('sha256').update(b).digest('hex')}
async function init(){
 await db.executeMultiple(`CREATE TABLE IF NOT EXISTS fbm_snapshots(
 id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 reason TEXT NOT NULL,
 app_version TEXT NOT NULL,
 size INTEGER NOT NULL,
 sha256 TEXT NOT NULL,
 payload TEXT NOT NULL
 );CREATE INDEX IF NOT EXISTS idx_fbm_snapshots_created_at ON fbm_snapshots(created_at DESC);`);
}
app.get('/api/health',async(req,res)=>{const started=process.hrtime.bigint();try{await db.execute('SELECT 1');res.json({ok:true,status:'healthy',version:VERSION,provider:'turso',latencyMs:Number(Number(process.hrtime.bigint()-started)/1_000_000).toFixed(2),timestamp:new Date().toISOString()})}catch(e){res.status(503).json({ok:false,status:'unhealthy',version:VERSION,provider:'turso',error:e.message,timestamp:new Date().toISOString()})}});
app.get('/api/health/database',async(req,res)=>{const started=process.hrtime.bigint();try{const count=await db.execute('SELECT COUNT(*) snapshotCount FROM fbm_snapshots');const latest=await db.execute('SELECT created_at createdAt,app_version appVersion,size,sha256 FROM fbm_snapshots ORDER BY created_at DESC LIMIT 1');res.json({ok:true,status:'healthy',provider:'turso',latencyMs:Number(Number(process.hrtime.bigint()-started)/1_000_000).toFixed(2),snapshotCount:count.rows[0]?.snapshotCount||0,latestSnapshot:latest.rows[0]||null,timestamp:new Date().toISOString()})}catch(e){res.status(503).json({ok:false,status:'unhealthy',provider:'turso',error:e.message,timestamp:new Date().toISOString()})}});
app.use('/api',auth);
app.get('/api/snapshots',async(req,res)=>{const r=await db.execute('SELECT id,created_at createdAt,reason,app_version appVersion,size,sha256 FROM fbm_snapshots ORDER BY created_at DESC LIMIT 50');res.json({snapshots:r.rows})});
app.get('/api/snapshots/latest',async(req,res)=>{const r=await db.execute('SELECT id,created_at createdAt,reason,app_version appVersion,size,sha256 FROM fbm_snapshots ORDER BY created_at DESC LIMIT 1');res.json({snapshot:r.rows[0]||null})});
app.get('/api/snapshots/latest/file',async(req,res)=>{const r=await db.execute('SELECT id,payload,sha256 FROM fbm_snapshots ORDER BY created_at DESC LIMIT 1');const row=r.rows[0];if(!row)return res.status(404).json({error:'No snapshot found.'});const b=Buffer.from(row.payload,'base64');if(sha256(b)!==row.sha256)return res.status(500).json({error:'Stored snapshot checksum failed.'});res.setHeader('content-type','application/vnd.sqlite3');res.setHeader('content-disposition',`attachment; filename=family-budget-${row.id}.db`);res.send(b)});
app.post('/api/snapshots',async(req,res)=>{const data=String(req.body?.data||''),declared=String(req.body?.sha256||''),reason=String(req.body?.reason||'automatic').slice(0,200),appVersion=String(req.body?.appVersion||'unknown').slice(0,30);let b;try{b=Buffer.from(data,'base64')}catch{return res.status(400).json({error:'Invalid base64 payload.'})}if(b.length<100||b.subarray(0,16).toString()!=='SQLite format 3\u0000')return res.status(400).json({error:'Payload is not a SQLite database.'});const digest=sha256(b);if(declared!==digest)return res.status(400).json({error:'Checksum mismatch.'});if(Number(req.body?.size)!==b.length)return res.status(400).json({error:'Size mismatch.'});const id=crypto.randomUUID(),createdAt=new Date().toISOString();await db.execute({sql:'INSERT INTO fbm_snapshots(id,created_at,reason,app_version,size,sha256,payload) VALUES(?,?,?,?,?,?,?)',args:[id,createdAt,reason,appVersion,b.length,digest,data]});const keep=Math.max(5,Math.min(100,Number(process.env.KEEP_SNAPSHOTS||30)));await db.execute({sql:'DELETE FROM fbm_snapshots WHERE id NOT IN (SELECT id FROM fbm_snapshots ORDER BY created_at DESC LIMIT ?)',args:[keep]});res.status(201).json({ok:true,snapshot:{id,createdAt,reason,appVersion,size:b.length,sha256:digest}})});
app.get('/api/integrity',async(req,res)=>{const r=await db.execute('SELECT id,size,sha256,payload FROM fbm_snapshots ORDER BY created_at DESC LIMIT 50');const checks=r.rows.map(x=>{const b=Buffer.from(x.payload,'base64');return {id:x.id,sizeOk:b.length===Number(x.size),checksumOk:sha256(b)===x.sha256,sqliteHeaderOk:b.subarray(0,16).toString()==='SQLite format 3\u0000'}});res.json({ok:checks.every(x=>x.sizeOk&&x.checksumOk&&x.sqliteHeaderOk),checks})});
app.use((e,req,res,next)=>{console.error(e);res.status(e.status||500).json({error:e.message||'Server error'})});
const port=Number(process.env.PORT||3001);init().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Family Budget Manager DBServer v${VERSION} on ${port}`))).catch(e=>{console.error(e);process.exit(1)});
module.exports={app,sha256};

const http = require('http');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const ENDPOINT = process.env.CLOUD_ENDPOINT || '';
const REGION = process.env.CLOUD_REGION || 'auto';
const BUCKET = process.env.CLOUD_BUCKET || '';
const ACCESS_KEY = process.env.CLOUD_ACCESS_KEY_ID || '';
const SECRET_KEY = process.env.CLOUD_SECRET_ACCESS_KEY || '';
const PREFIX = process.env.CLOUD_PREFIX || 'black-hole/';

const configured = Boolean(ENDPOINT && BUCKET && ACCESS_KEY && SECRET_KEY);
const s3 = configured ? new S3Client({ region: REGION, endpoint: ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } }) : null;

function send(res,status,body,origin=''){
  if(origin===ALLOWED_ORIGIN){res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);res.setHeader('Vary','Origin')}
  res.setHeader('Content-Type','application/json; charset=utf-8');res.writeHead(status);res.end(JSON.stringify(body));
}
function readJson(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>20000){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch{reject(new Error('Invalid JSON'))}});req.on('error',reject)})}
function safeName(name){return String(name||'').replace(/[^a-zA-Z0-9._() -]/g,'_').slice(0,180)}

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){
    if(origin===ALLOWED_ORIGIN){res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type')}
    res.writeHead(204);return res.end();
  }
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/health')) return send(res,200,{name:'Black Hole Cloud',status:'online',configured,bucket:configured?BUCKET:null},origin);
  if(origin!==ALLOWED_ORIGIN) return send(res,403,{error:'Origin not allowed'},origin);
  if(!configured) return send(res,503,{error:'Cloud storage is not configured yet. Add CLOUD_ENDPOINT, CLOUD_BUCKET, CLOUD_ACCESS_KEY_ID and CLOUD_SECRET_ACCESS_KEY in Railway.'},origin);
  try{
    if(req.method==='GET'&&url.pathname==='/files'){
      const d=await s3.send(new ListObjectsV2Command({Bucket:BUCKET,Prefix:PREFIX,MaxKeys:200}));
      const files=(d.Contents||[]).filter(x=>x.Key&&x.Key!==PREFIX).map(x=>({key:x.Key,name:x.Key.slice(PREFIX.length),size:x.Size||0,updated:x.LastModified||null})).sort((a,b)=>new Date(b.updated)-new Date(a.updated));
      return send(res,200,{files},origin);
    }
    if(req.method==='POST'&&url.pathname==='/upload-url'){
      const b=await readJson(req);const name=safeName(b.name);const type=String(b.type||'application/octet-stream').slice(0,120);if(!name)return send(res,400,{error:'Missing file name'},origin);
      const key=PREFIX+Date.now()+'-'+name;const cmd=new PutObjectCommand({Bucket:BUCKET,Key:key,ContentType:type});const uploadUrl=await getSignedUrl(s3,cmd,{expiresIn:300});return send(res,200,{key,uploadUrl},origin);
    }
    if(req.method==='GET'&&url.pathname==='/download-url'){
      const key=url.searchParams.get('key')||'';if(!key.startsWith(PREFIX))return send(res,400,{error:'Invalid key'},origin);const downloadUrl=await getSignedUrl(s3,new GetObjectCommand({Bucket:BUCKET,Key:key}),{expiresIn:300});return send(res,200,{downloadUrl},origin);
    }
    if(req.method==='DELETE'&&url.pathname==='/file'){
      const b=await readJson(req);const key=String(b.key||'');if(!key.startsWith(PREFIX))return send(res,400,{error:'Invalid key'},origin);await s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:key}));return send(res,200,{ok:true},origin);
    }
    return send(res,404,{error:'Not found'},origin);
  }catch(e){console.error('Cloud error:',e.message);return send(res,500,{error:e.message||'Cloud request failed'},origin)}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Black Hole Cloud listening on ${PORT} configured=${configured}`));
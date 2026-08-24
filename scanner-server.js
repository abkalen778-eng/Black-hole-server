const http = require('http');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

const TARGETS = [
  { id:'black-hole', name:'Black Hole Backend', type:'api', url:'https://black-hole-backend-production.up.railway.app/health' },
  { id:'pumpfun', name:'Pump.fun Bot', type:'bot', url:'https://pumpfun-discord-scanner-production.up.railway.app/health' },
  { id:'fanduel', name:'FanDuel Bot', type:'bot', url:'https://fanduel-scanner-production.up.railway.app/health' },
  { id:'pocket', name:'Pocket Option Bot', type:'bot', url:'https://pumpfun-discord-scanner-production-10b7.up.railway.app/health' }
];

let latest = [];
let lastRun = null;
let running = false;
let cryptoBaseline = null;

function sendJson(res,status,body,origin){
  if(origin===ALLOWED_ORIGIN){res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);res.setHeader('Vary','Origin');}
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function probe(target){
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),8000);
  try{
    const r = await fetch(target.url,{signal:controller.signal,headers:{'User-Agent':'Black-Hole-Scanner-Farm/1.0'}});
    const latencyMs = Date.now()-started;
    let detail='';
    try{const data=await r.json(); detail=data.status||data.name||'';}catch{}
    return {id:target.id,name:target.name,type:target.type,status:r.ok?'OK':'ALERT',httpStatus:r.status,latencyMs,detail,checkedAt:new Date().toISOString()};
  }catch(err){
    return {id:target.id,name:target.name,type:target.type,status:'ERROR',httpStatus:null,latencyMs:Date.now()-started,detail:err.name==='AbortError'?'timeout':err.message,checkedAt:new Date().toISOString()};
  }finally{clearTimeout(timer);}
}

async function scanCrypto(){
  const url='https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple&vs_currencies=usd';
  try{
    const r=await fetch(url,{headers:{'User-Agent':'Black-Hole-Scanner-Farm/1.0'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    const now={btc:d.bitcoin?.usd,eth:d.ethereum?.usd,xrp:d.ripple?.usd};
    const prior=cryptoBaseline;
    cryptoBaseline=now;
    return Object.entries(now).map(([symbol,price])=>{
      const before=prior?.[symbol];
      const changePct=(Number.isFinite(before)&&before!==0)?((price-before)/before)*100:null;
      const status=changePct!==null&&Math.abs(changePct)>=1?'ALERT':'OK';
      return {id:`crypto-${symbol}`,name:`${symbol.toUpperCase()} movement`,type:'crypto',status,priceUsd:price,changePct,detail:changePct===null?'baseline created':`${changePct>=0?'+':''}${changePct.toFixed(2)}% since last scan`,checkedAt:new Date().toISOString()};
    });
  }catch(err){
    return ['btc','eth','xrp'].map(symbol=>({id:`crypto-${symbol}`,name:`${symbol.toUpperCase()} movement`,type:'crypto',status:'ERROR',detail:err.message,checkedAt:new Date().toISOString()}));
  }
}

async function runScans(){
  if(running) return;
  running=true;
  try{
    const [targets,crypto]=await Promise.all([Promise.all(TARGETS.map(probe)),scanCrypto()]);
    latest=[...targets,...crypto];
    lastRun=new Date().toISOString();
  }finally{running=false;}
}

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';
  const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){
    if(origin===ALLOWED_ORIGIN){res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
    res.writeHead(204);return res.end();
  }
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/health')) return sendJson(res,200,{name:'Black Hole Scanner Farm',status:'online',version:'1.0.0',lastRun,running,scanIntervalMinutes:SCAN_INTERVAL_MS/60000,timestamp:new Date().toISOString()},origin);
  if(req.method==='GET'&&url.pathname==='/scanners') return sendJson(res,200,{lastRun,running,scanIntervalMinutes:SCAN_INTERVAL_MS/60000,scanners:latest},origin);
  if(req.method==='POST'&&url.pathname==='/scan-now'){
    if(origin!==ALLOWED_ORIGIN) return sendJson(res,403,{error:'Origin not allowed'},origin);
    await runScans(); return sendJson(res,200,{ok:true,lastRun,scanners:latest},origin);
  }
  return sendJson(res,404,{error:'Not found'},origin);
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Black Hole Scanner Farm listening on ${PORT}`);
  runScans().catch(console.error);
  setInterval(()=>runScans().catch(console.error),SCAN_INTERVAL_MS);
});

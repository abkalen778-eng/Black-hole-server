const http = require('http');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = 'https://abkalen778-eng.github.io';
const PISTON = 'https://emkc.org/api/v2/piston/execute';
const MAP = {
  python: { language: 'python', version: '3.10.0', file: 'main.py' },
  javascript: { language: 'javascript', version: '18.15.0', file: 'main.js' }
};

function send(res, status, body, origin='') {
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function bodyJson(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{b+=c;if(b.length>30000){reject(new Error('Request too large'));req.destroy();}});
    req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch{reject(new Error('Invalid JSON'))}});
    req.on('error',reject);
  });
}

const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin||'';
  const url=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){
    if(origin===ALLOWED_ORIGIN){
      res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
    }
    res.writeHead(204);return res.end();
  }
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/health')){
    return send(res,200,{name:'Black Hole Code Runner',status:'online',languages:Object.keys(MAP),sandbox:'Piston isolated runtime'},origin);
  }
  if(req.method==='POST'&&url.pathname==='/run'){
    if(origin!==ALLOWED_ORIGIN) return send(res,403,{error:'Origin not allowed'},origin);
    try{
      const b=await bodyJson(req);
      const key=String(b.language||'').toLowerCase();
      const spec=MAP[key];
      const code=typeof b.code==='string'?b.code:'';
      if(!spec) return send(res,400,{error:'Supported languages: Python and JavaScript'},origin);
      if(!code||code.length>20000) return send(res,400,{error:'Code must be 1-20000 characters'},origin);
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),12000);
      const r=await fetch(PISTON,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({language:spec.language,version:spec.version,files:[{name:spec.file,content:code}],run_timeout:5000,compile_timeout:5000})});
      clearTimeout(timer);
      const d=await r.json();
      if(!r.ok) return send(res,502,{error:d.message||'Sandbox service failed'},origin);
      return send(res,200,{stdout:d.run?.stdout||'',stderr:d.run?.stderr||'',code:d.run?.code??null,signal:d.run?.signal||null},origin);
    }catch(e){
      return send(res,e.name==='AbortError'?504:500,{error:e.name==='AbortError'?'Code execution timed out':e.message},origin);
    }
  }
  return send(res,404,{error:'Not found'},origin);
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Black Hole Code Runner listening on ${PORT}`));
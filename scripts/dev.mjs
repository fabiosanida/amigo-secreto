import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import handler from '../api/index.js';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')) {
    req.query=Object.fromEntries(url.searchParams);req.query.path=url.pathname.slice(5);
    try {
      if(!['GET','HEAD'].includes(req.method)) {
        let raw='';for await(const chunk of req) {raw+=chunk;if(raw.length>600000){res.writeHead(413).end();return;}}
        req.body=raw?JSON.parse(raw):{};
      }
      await handler(req,res);
    }catch(err){console.error('API error',err.code||err.name);if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:'INTERNAL_ERROR',message:'Não foi possível concluir. Tente novamente.'}));}
    return;
  }
  try{
    const filename=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!filename.startsWith(root)||url.pathname.split('/').some(p=>p.startsWith('.'))){res.writeHead(403).end();return;}
    const body=await readFile(filename);res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream','cache-control':'no-store'}).end(body);
  }catch{res.writeHead(404).end('Not found');}
}).listen(4174,'127.0.0.1',()=>console.log('Aplicação: http://127.0.0.1:4174'));

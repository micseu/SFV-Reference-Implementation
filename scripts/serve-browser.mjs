import fs from 'node:fs';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SFVMediaNetworkEmulator} from './network/SFVMediaNetworkEmulator.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dashRoot=path.resolve(process.env.SFV_DASHJS_ROOT??path.join(root,'../dash.js'));
const dashBundle=path.join(dashRoot,'dist/modern/umd/dash.all.min.js');
if(!fs.existsSync(dashBundle))throw new Error(`Patched dash.js browser bundle missing: ${dashBundle}; run npm run webpack-build-modern in your patched dash.js checkout`);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mpd':'application/dash+xml','.m4s':'video/iso.segment','.json':'application/json; charset=utf-8'};
const emulator=new SFVMediaNetworkEmulator();
const serverInstanceId=randomUUID();
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/__sfv/clock'){
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({schemaVersion:1,clock:'node_performance_seconds',
      serverInstanceId,serverTimeS:performance.now()/1000,serverUnixTimeMs:Date.now()}));
    return;
  }
  if(pathname==='/__sfv/emulation'){
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');
    if(req.method==='GET'){res.end(JSON.stringify({...emulator.snapshot(),serverInstanceId}));return;}
    if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
    let body='';
    req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});
    req.on('end',()=>{
      try{const profile=JSON.parse(body);if(profile===null||profile.enabled===false)emulator.disable();
        else emulator.configure(profile);
        res.end(JSON.stringify({...emulator.snapshot(),serverInstanceId}));}
      catch(error){res.writeHead(error.message.includes('active')||error.message.includes('Active')?409:400);
        res.end(JSON.stringify({error:error.message}));}
    });return;
  }
  const filename=pathname==='/vendor/dash.all.min.js'?dashBundle:
    pathname==='/'?path.join(root,'browser/index.html'):
    pathname.startsWith('/media/')?path.resolve(root,'fixtures/dash',pathname.slice('/media/'.length)):
    path.resolve(root,`.${pathname}`);
  if(filename!==dashBundle&&!filename.startsWith(`${root}${path.sep}`)){
    res.writeHead(403);res.end();return;
  }
  if(!fs.existsSync(filename)||!fs.statSync(filename).isFile()){
    res.writeHead(404);res.end('Not found');return;
  }
  const contentType=mime[path.extname(filename)]??'application/octet-stream';
  res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');
  if(pathname.startsWith('/media/')&&emulator.profile){
    emulator.serve(req,res,{filePath:filename,pathname,contentType});return;
  }
  res.writeHead(200,{'content-type':contentType});
  if(req.method==='HEAD'){res.end();return;}
  fs.createReadStream(filename).pipe(res);
});
server.listen(Number(process.env.PORT??8080),'127.0.0.1',()=>{
  console.log(`SFV browser demo: http://127.0.0.1:${server.address().port}/`);
});

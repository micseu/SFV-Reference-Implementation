import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {SFVMediaNetworkEmulator} from '../scripts/network/SFVMediaNetworkEmulator.mjs';

const webRoot=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(webRoot,'..');
const mediaRoot=path.join(root,'fixtures/dash');
const mime={'.mpd':'application/dash+xml','.m4s':'video/iso.segment'};

/** Serves the single-UE browser console, the shared src/ modules, DASH fixtures and the control endpoints. */
export function createApp({dashRoot=process.env.SFV_DASHJS_ROOT??path.join(root,'../dash.js'),
  emulator=new SFVMediaNetworkEmulator(),serverInstanceId=randomUUID()}={}){
  const dashBundle=path.join(path.resolve(dashRoot),'dist/modern/umd/dash.all.min.js');
  if(!fs.existsSync(dashBundle))throw new Error(`Patched dash.js browser bundle missing: ${dashBundle}; run npm run webpack-build-modern in your patched dash.js checkout`);
  const staticOptions={etag:false,lastModified:false,setHeaders(res,file){
    res.setHeader('access-control-allow-origin','*');res.setHeader('cache-control','no-store');
    if(mime[path.extname(file)])res.setHeader('content-type',mime[path.extname(file)]);}};
  const noStore=(req,res,next)=>{res.set('cache-control','no-store');next();};
  const app=express();
  app.disable('x-powered-by');

  app.get('/__sfv/clock',noStore,(req,res)=>res.json({schemaVersion:1,clock:'node_performance_seconds',
    serverInstanceId,serverTimeS:performance.now()/1000,serverUnixTimeMs:Date.now()}));

  app.route('/__sfv/emulation').all(noStore)
    .get((req,res)=>res.json({...emulator.snapshot(),serverInstanceId}))
    .post(express.json({limit:'64kb',strict:false,type:()=>true}),(req,res)=>{
      try{const profile=req.body;
        if(profile===undefined)throw new Error('Missing emulation profile body');
        if(profile===null||profile.enabled===false)emulator.disable();else emulator.configure(profile);
        res.json({...emulator.snapshot(),serverInstanceId});}
      catch(error){res.status(/active/i.test(error.message)?409:400).json({error:error.message});}
    })
    .all((req,res)=>res.status(405).json({}));

  app.get('/vendor/dash.all.min.js',(req,res)=>res.sendFile(dashBundle,
    {etag:false,lastModified:false,headers:{'cache-control':'no-store','access-control-allow-origin':'*'}}));

  // Emulated media path: only fixture media goes through the shared-capacity emulator.
  app.use('/media',(req,res,next)=>{
    if(!emulator.profile||!['GET','HEAD'].includes(req.method))return next();
    const filePath=path.resolve(mediaRoot,`.${decodeURIComponent(req.path)}`);
    if(!filePath.startsWith(`${mediaRoot}${path.sep}`)||!fs.existsSync(filePath)||!fs.statSync(filePath).isFile())return next();
    res.setHeader('access-control-allow-origin','*');
    emulator.serve(req,res,{filePath,pathname:`/media${req.path}`,
      contentType:mime[path.extname(filePath)]??'application/octet-stream'});
  },express.static(mediaRoot,staticOptions));

  app.use('/src',express.static(path.join(root,'src'),staticOptions));
  app.use(express.static(path.join(webRoot,'public'),staticOptions));
  app.use((req,res)=>res.status(404).type('text').send('Not found'));
  app.use((error,req,res,next)=>{  // body-parser errors (bad JSON → 400, oversized → 413)
    if(res.headersSent)return next(error);
    res.status(error.status??500).json({error:error.message});});
  return app;
}

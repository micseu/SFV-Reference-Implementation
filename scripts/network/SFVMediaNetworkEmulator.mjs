import fs from 'node:fs';
import {performance} from 'node:perf_hooks';

/** HTTP response-rate emulator for local tests; not a packet/TCP/QUIC emulator. */
export class SFVMediaNetworkEmulator {
  constructor({tickMs=25,now=()=>performance.now()/1000}={}){
    this.now=now;this.tickMs=tickMs;this.profile=null;this.transfers=new Set();this.events=[];
    this.attempts=new Map();this.timer=null;this.lastTick=this.now();
  }
  configure({capacityTrace,capacityMbps,latencyMs=0,faults=[]}={}){
    const trace=capacityTrace??[[0,capacityMbps??8]];
    if(!Array.isArray(trace)||!trace.length||trace.some((entry,i)=>!Array.isArray(entry)||entry.length!==2||
      !Number.isFinite(entry[0])||entry[0]<0||!Number.isFinite(entry[1])||entry[1]<0||
      (i===0&&entry[0]!==0)||(i>0&&entry[0]<=trace[i-1][0])))throw new TypeError('Invalid capacity trace');
    if(!Number.isFinite(latencyMs)||latencyMs<0)throw new TypeError('Invalid latencyMs');
    if(!Array.isArray(faults)||faults.some(f=>typeof f.pathIncludes!=='string'||
      (f.status!==undefined&&(!Number.isInteger(f.status)||f.status<400||f.status>599))||
      (f.truncateAfterBytes!==undefined&&(!Number.isSafeInteger(f.truncateAfterBytes)||f.truncateAfterBytes<0))||
      (f.occurrence!==undefined&&(!Number.isSafeInteger(f.occurrence)||f.occurrence<1))))throw new TypeError('Invalid HTTP faults');
    if(this.transfers.size)throw new Error('Cannot replace network profile while transfers are active');
    this.profile={capacityTrace:structuredClone(trace),latencyMs,faults:structuredClone(faults)};
    this.startedAt=this.now();this.lastTick=this.startedAt;this.events=[];this.attempts.clear();
    this.nextCapacityEventIndex=1;
    this.events.push({eventType:'EMULATION_STARTED',atS:0,capacityMbps:trace[0][1]});
    return this.snapshot();
  }
  disable(){if(this.transfers.size)throw new Error('Active transfers prevent disabling emulation');this.profile=null;this.events=[];this.attempts.clear();}
  snapshot(){const sampledAtServerS=this.now();this.#recordCapacityChanges();return {profile:structuredClone(this.profile),
    sampledAtServerS,startedAtServerS:this.profile?this.startedAt:null,elapsedS:this.profile?sampledAtServerS-this.startedAt:null,
    activeTransfers:this.transfers.size,events:structuredClone(this.events)};}
  #recordCapacityChanges(){
    if(!this.profile)return;
    const elapsed=this.now()-this.startedAt;
    while(this.nextCapacityEventIndex<this.profile.capacityTrace.length &&
      this.profile.capacityTrace[this.nextCapacityEventIndex][0]<=elapsed){
      const [atS,capacityMbps]=this.profile.capacityTrace[this.nextCapacityEventIndex++];
      this.events.push({eventType:'NETWORK_CAPACITY_CHANGED',atS,capacityMbps});
    }
  }
  capacityAt(timeS){
    let value=this.profile?.capacityTrace?.[0]?.[1]??Infinity;
    for(const [at,capacity] of this.profile?.capacityTrace??[]){if(at>timeS)break;value=capacity;}
    return value;
  }
  /** This path is used ONLY for media, not JavaScript files, the manifest or control endpoints. */
  serve(req,res,{filePath,pathname,contentType='application/octet-stream'}){
    if(!this.profile){res.writeHead(200,{'content-type':contentType,'cache-control':'no-store'});
      fs.createReadStream(filePath).pipe(res);return;}
    const count=(this.attempts.get(pathname)??0)+1;this.attempts.set(pathname,count);
    const fault=this.profile.faults.find(f=>pathname.includes(f.pathIncludes)&&
      (f.occurrence===undefined||f.occurrence===count));
    if(fault?.status){res.writeHead(fault.status,{'cache-control':'no-store'});res.end('Injected HTTP fault');
      this.events.push({eventType:'HTTP_FAULT',path:pathname,attempt:count,status:fault.status,atS:this.now()-this.startedAt});return;}
    const buffer=fs.readFileSync(filePath);
    if(req.method==='HEAD'){res.writeHead(200,{'content-length':buffer.length,'content-type':contentType});res.end();return;}
    res.writeHead(200,{'content-type':contentType,'content-length':buffer.length,'cache-control':'no-store'});
    const transfer={res,pathname,bytes:buffer,offset:0,readyAt:this.now()+this.profile.latencyMs/1000,
      truncateAfterBytes:fault?.truncateAfterBytes??null,blocked:false};
    this.transfers.add(transfer);
    this.events.push({eventType:'HTTP_STARTED',path:pathname,attempt:count,atS:this.now()-this.startedAt});
    res.on('drain',()=>{transfer.blocked=false;});
    res.on('close',()=>{this.transfers.delete(transfer);this.#stopIdle();});
    this.#startTick();
  }
  #startTick(){if(this.timer)return;this.lastTick=this.now();this.timer=setInterval(()=>this.#tick(),this.tickMs);}
  #stopIdle(){if(this.timer&&this.transfers.size===0){clearInterval(this.timer);this.timer=null;}}
  #tick(){
    const current=this.now(),start=this.lastTick;this.lastTick=current;
    if(!this.profile)return;
    this.#recordCapacityChanges();
    const active=[...this.transfers].filter(t=>!t.res.destroyed&&!t.blocked&&current>=t.readyAt);
    if(!active.length){this.#stopIdle();return;}
    // Integrate every capacity step within this scheduling tick, not just the end rate.
    let bytes=0,from=Math.max(0,start-this.startedAt),to=Math.max(from,current-this.startedAt);
    const changes=this.profile.capacityTrace.filter(([t])=>t>from&&t<to).map(([t])=>t);
    for(const end of [...changes,to]){bytes+=(end-from)*this.capacityAt(from)*1e6/8;from=end;}
    const quota=Math.floor(bytes/active.length);
    for(const t of active){
      const remaining=t.bytes.length-t.offset;
      const untilTruncation=t.truncateAfterBytes===null?Infinity:t.truncateAfterBytes-t.offset;
      const n=Math.min(remaining,Math.max(0,untilTruncation),quota);
      if(n>0){t.blocked=!t.res.write(t.bytes.subarray(t.offset,t.offset+n));t.offset+=n;}
      if(t.truncateAfterBytes!==null&&t.offset>=t.truncateAfterBytes&&t.offset<t.bytes.length){
        this.events.push({eventType:'HTTP_TRUNCATED',path:t.pathname,deliveredBytes:t.offset,atS:current-this.startedAt});
        t.res.destroy(new Error('Injected truncated response'));this.transfers.delete(t);
      }else if(t.offset===t.bytes.length){
        this.events.push({eventType:'HTTP_COMPLETED',path:t.pathname,deliveredBytes:t.offset,atS:current-this.startedAt});
        t.res.end();this.transfers.delete(t);
      }
    }
    this.#stopIdle();
  }
  close(){if(this.timer)clearInterval(this.timer);this.timer=null;for(const t of this.transfers)t.res.destroy();this.transfers.clear();}
}

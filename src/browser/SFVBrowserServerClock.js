/**
 * Aligns a Node.js performance clock with a browser performance clock through
 * midpoint samples. Clock synchronization never changes the ABR time source;
 * it only translates server diagnostics for reporting.
 */
export class SFVBrowserServerClock {
  constructor({fetchImpl=globalThis.fetch?.bind(globalThis),now=()=>performance.now()/1000,
    path='/__sfv/clock'}={}) {
    if(typeof fetchImpl!=='function'||typeof now!=='function')throw new TypeError('fetch and now functions required');
    this.fetchImpl=fetchImpl;this.now=now;this.path=path;
    this.best=null;this.last=null;this.history=[];this.serverInstanceId=null;
  }
  async probe(){
    const sentS=this.now();
    const response=await this.fetchImpl(this.path,{cache:'no-store'});
    if(!response.ok)throw new Error(`Clock endpoint HTTP ${response.status}`);
    const reading=await response.json();
    const receivedS=this.now();
    if(reading.schemaVersion!==1||reading.clock!=='node_performance_seconds'||
      !Number.isFinite(reading.serverTimeS)||typeof reading.serverInstanceId!=='string'||
      !reading.serverInstanceId||receivedS<sentS)throw new Error('Invalid server clock sample');
    if(this.serverInstanceId&&this.serverInstanceId!==reading.serverInstanceId){
      this.best=null;this.history=[];
    }
    this.serverInstanceId=reading.serverInstanceId;
    const roundTripS=receivedS-sentS;
    const sample={offsetS:reading.serverTimeS-(sentS+receivedS)/2,
      roundTripS,exchangeErrorBoundS:roundTripS/2,sentS,receivedS,
      serverTimeS:reading.serverTimeS,serverInstanceId:reading.serverInstanceId};
    this.last=sample;
    if(!this.best||sample.roundTripS<this.best.roundTripS)this.best=sample;
    this.history.push(sample);
    if(this.history.length>50)this.history.shift();
    return sample;
  }
  async synchronize({samples=5}={}){
    if(!Number.isInteger(samples)||samples<1||samples>20)throw new TypeError('samples must be 1..20');
    let lastError=null;
    for(let i=0;i<samples;i++){
      try{await this.probe();}catch(error){lastError=error;}
    }
    if(!this.best)throw lastError??new Error('No clock samples available');
    return this.snapshot();
  }
  serverToSessionS(serverTimeS,sessionEpochClientS){
    if(!Number.isFinite(serverTimeS)||!Number.isFinite(sessionEpochClientS)||!this.best)return null;
    return serverTimeS-this.best.offsetS-sessionEpochClientS;
  }
  /** Keep server timestamps intact while producing session-relative diagnostic events. */
  alignEmulatorEvents(snapshot,{sessionEpochClientS}={}){
    if(!this.best||!snapshot?.profile||snapshot.serverInstanceId!==this.serverInstanceId||
      !Number.isFinite(snapshot.startedAtServerS)||!Number.isFinite(sessionEpochClientS))return [];
    const eligible=new Set(['EMULATION_STARTED','NETWORK_CAPACITY_CHANGED','HTTP_FAULT','HTTP_TRUNCATED']);
    return (snapshot.events??[]).filter(e=>eligible.has(e.eventType)&&Number.isFinite(e.atS)).map(e=>{
      const serverTimeS=snapshot.startedAtServerS+e.atS;
      return {...e,serverTimeS,time:this.serverToSessionS(serverTimeS,sessionEpochClientS),
        clockExchangeErrorBoundS:this.best.exchangeErrorBoundS};
    });
  }
  snapshot(){
    return {schemaVersion:1,method:'http_midpoint_minimum_rtt',
      clientClock:'browser_performance_seconds',serverClock:'node_performance_seconds',
      serverInstanceId:this.serverInstanceId,offsetServerMinusClientS:this.best?.offsetS??null,
      exchangeErrorBoundS:this.best?.exchangeErrorBoundS??null,roundTripS:this.best?.roundTripS??null,
      bestSampleClientTimeS:this.best?.receivedS??null,sampleCount:this.history.length,
      recentSamples:structuredClone(this.history)};
  }
}

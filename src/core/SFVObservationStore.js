export class SFVObservationStore {
  constructor(){ this.events=[]; this.nextId=1; }
  append(event){ const e={eventId:this.nextId++,...structuredClone(event)}; this.events.push(e); return e; }
  list(filter={}){ return this.events.filter(e=>Object.entries(filter).every(([k,v])=>e[k]===v)).map(x=>structuredClone(x)); }
}

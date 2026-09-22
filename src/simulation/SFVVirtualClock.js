export class SFVVirtualClock { constructor(){this.t=0;} now(){return this.t;} advanceTo(t){if(t<this.t-1e-9)throw new Error('Clock cannot go backwards');this.t=t;} reset(){this.t=0;} }

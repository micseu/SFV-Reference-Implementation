#!/usr/bin/env node
import readline from 'node:readline';
import { SFVCurrentVideoRule } from '../rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../rules/SFVMultiVideoPrefetchRule.js';
import { contextFromSnapshot } from './contextFromSnapshot.js';
const rules={current:SFVCurrentVideoRule,prefetch:SFVMultiVideoPrefetchRule};let rule=null;
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){
  let msg;try{msg=JSON.parse(line);let result;
    if(msg.type==='initialize'){const C=rules[msg.rule];if(!C)throw new Error(`Unknown rule ${msg.rule}`);rule=new C();rule.reset(msg.config??{},msg.seed??1);result={ok:true};}
    else if(msg.type==='decide'){if(!rule)throw new Error('Not initialized');const ctx=contextFromSnapshot(msg.context);rule.onObservationBatch?.(msg.observations??[],ctx);result={actionBatch:rule.getSwitchRequest(ctx)};}
    else if(msg.type==='getState'){result={state:rule.getState()};}
    else if(msg.type==='setState'){rule.setState(msg.state);result={ok:true};}
    else if(msg.type==='reset'){rule.reset(msg.config??{},msg.seed??1);result={ok:true};}
    else if(msg.type==='shutdown'){process.stdout.write(JSON.stringify({id:msg.id,ok:true})+'\n');rl.close();break;}
    else throw new Error(`Unknown message type ${msg.type}`);
    process.stdout.write(JSON.stringify({id:msg.id,ok:true,...result})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({id:msg?.id??null,ok:false,error:{message:e.message}})+'\n');}
}

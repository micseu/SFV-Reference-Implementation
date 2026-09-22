import fs from 'node:fs';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import {writeCompactEventArtifacts,networkCapacityEvents} from './compact-event-artifacts.mjs';

const dataset = JSON.parse(fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url)));
const timingDefaults = {maxTimeS:30,sessionStartWindowS:[0,5],
  sessionDurationRangeS:[8,15],swipeTimesS:[3,6]};
const runner = new SFVSimulationRunner({dataset,timingDefaults,
  network:{capacityTrace:[[0,8],[6,3],[12,10],[20,5]],latencyMs:40},
  sessions:[0,1,2].map(index => ({
    ruleFactory: index === 1 ? () => new SFVMultiVideoPrefetchRule() : () => new SFVCurrentVideoRule(),
    config:{sessionId:`ue-${index}`,ueId:index,seed:17,playerBehavior:index === 1 ? 'B2' : 'B1',
      rule:{activeBufferTargetSegments:2,max_preload_segments:4,preload_segments_per_video:2}}
  }))
});
const results = runner.run();
fs.mkdirSync('out',{recursive:true});
fs.writeFileSync('out/multi-ue-network.json', JSON.stringify(runner.lastNetworkReport,null,2));
for (const [index,result] of results.entries()) {
  writeCompactEventArtifacts({result,outputDirectory:'out',prefix:`multi-ue-${index}`,
    networkEvents:networkCapacityEvents(runner.lastNetworkReport,result.timeS)});
  fs.writeFileSync(`out/multi-ue-${index}-session.json`,JSON.stringify(result.sessionRecord,null,2));
  fs.writeFileSync(`out/multi-ue-${index}-events.jsonl`,result.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
}
console.log(JSON.stringify(results.map((result,index)=>({
  ue_id:index,session_started_at_s:result.sessionRecord.session_timing.session_started_at_s,
  scheduled_end_at_s:result.sessionRecord.session_timing.scheduled_end_at_s,
  termination_reason:result.terminationReason,
  initial_playback_delay_s:result.sessionRecord.session_summary.initial_playback_delay_s
})),null,2));

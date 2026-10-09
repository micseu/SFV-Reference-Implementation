import fs from 'node:fs';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import { writeCompactEventArtifacts } from './compact-event-artifacts.mjs';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);
const mode = process.argv[2] ?? 'current';
const Rule = mode === 'prefetch' ? SFVMultiVideoPrefetchRule : SFVCurrentVideoRule;
const rule = new Rule();
const out = new SFVSimulationController({
  dataset,
  rule,
  config: {
    runId: `demo-${mode}`,
    sessionId: 'ue0',
    ueId: 0,
    seed: 17,
    maxTimeS: 12,
    sessionStartWindowS: [0.5, 1.5],
    sessionDurationRangeS: [8, 10],
    swipeTimesS: [2.8, 5.4],
    playerBehavior: mode,
    scheduling: { swipeCancellation: true },
    transport: {
      capacityMbps: 4,
      latencyMs: 40,
      cancelTailBytes: 1024,
      cancelTailMs: 20
    },
    rule: {
      activeBufferTargetSegments: 2,
      max_preload_segments: 4,
      preload_segments_per_video: 2
    }
  }
}).run();

fs.mkdirSync('out', { recursive: true });
writeCompactEventArtifacts({
  result: out,
  outputDirectory: 'out',
  prefix: mode,
  networkEvents: [{ eventType: 'EMULATION_STARTED', time: 0, capacityMbps: 4 }]
});
fs.writeFileSync(
  `out/${mode}-events.jsonl`,
  out.events.map(item => JSON.stringify(item)).join('\n') + '\n'
);
fs.writeFileSync(
  `out/${mode}-requests.jsonl`,
  out.requests.map(item => JSON.stringify(item)).join('\n') + '\n'
);
fs.writeFileSync(`out/${mode}-session.json`, JSON.stringify(out.sessionRecord, null, 2));

console.log(
  JSON.stringify(
    {
      mode,
      timeS: out.timeS,
      terminationReason: out.terminationReason,
      requests: out.requests.length,
      decisions: out.events.filter(event => event.eventType === 'RULE_DECISION').length,
      bytesDelivered: out.sessionRecord.session_summary.bytes_delivered,
      bytesMediaDelivered: out.sessionRecord.session_summary.bytes_media_delivered,
      bytesDataWastage: out.sessionRecord.session_summary.bytes_data_wastage,
      dataWastageByReason: out.sessionRecord.session_summary.data_wastage_by_reason,
      bytesUnresolvedAtCutoff: out.sessionRecord.session_summary.bytes_unresolved_at_cutoff
    },
    null,
    2
  )
);

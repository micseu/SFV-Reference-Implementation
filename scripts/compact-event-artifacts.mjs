import fs from 'node:fs';
import path from 'node:path';
import { buildCompactEventLog, formatCompactEventLog } from '../src/output/SFVCompactEventLog.js';

/** The global network log is a separate source; per-UE REQUEST_* events are already in result.events. */
export function networkCapacityEvents(networkReport, resultTimeS = Infinity) {
  if (!networkReport?.capacityTrace?.length) return [];
  const events = [
    { eventType: 'EMULATION_STARTED', time: 0, capacityMbps: networkReport.capacityTrace[0][1] }
  ];
  events.push(
    ...(networkReport.events ?? []).filter(
      e => e.eventType === 'NETWORK_CAPACITY_CHANGED' && e.time <= resultTimeS
    )
  );
  return events;
}

/** Preserve raw events, request records and session record; export this as a supplemental view. */
export function writeCompactEventArtifacts({
  result,
  outputDirectory,
  prefix,
  networkEvents = []
}) {
  const log = buildCompactEventLog({
    events: result.events,
    networkEvents,
    sessionRecord: result.sessionRecord,
    clockOrigin: 'experiment_start'
  });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const jsonName = `${prefix}-compact-events.json`,
    textName = `${prefix}-compact-events.txt`;
  fs.writeFileSync(path.join(outputDirectory, jsonName), JSON.stringify(log, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDirectory, textName), formatCompactEventLog(log) + '\n');
  return { log, jsonName, textName };
}

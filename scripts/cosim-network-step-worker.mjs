#!/usr/bin/env node
// Co-simulation player process: one JSON message per line on stdin, one reply per line on stdout.
// The protocol is described in docs/CO_SIMULATION.md.
import readline from 'node:readline';
import { SFVNetworkStepHarness } from '../src/cosim/SFVNetworkStepHarness.js';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let harness;
for await (const line of input) {
  try {
    const message = JSON.parse(line);
    let reply;
    if (message.type === 'initialize') {
      if (harness) throw new Error('Player already initialized');
      harness = new SFVNetworkStepHarness(message.config);
      reply = { type: 'initialized' };
    } else if (!harness) throw new Error('Player not initialized');
    else if (message.type === 'network_step') reply = harness.onStep(message.step);
    else if (message.type === 'cap_reports')
      reply = { type: 'cap_reports', reports: harness.getCapReports() };
    else throw new Error(`Unknown IPC message ${message.type}`);
    process.stdout.write(JSON.stringify(reply) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ type: 'error', message: String(error.message ?? error) }) + '\n'
    );
  }
}

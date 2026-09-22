import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeScenarioFiles} from './prepare-scenarios.mjs';
import {compareOneTwo} from './compare-scenarios.mjs';
import {runExperiment} from '../run-experiment.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const scenarioPath=path.resolve(process.argv[2]??path.join(root,'scenarios/validation/scenario-b1-v1.json'));
const target=path.resolve(process.argv[3]??path.join(root,'out/validation-b1'));
try{
  const {scenario,one,two}=writeScenarioFiles(JSON.parse(fs.readFileSync(scenarioPath,'utf8')),path.join(target,'configs'));
  runExperiment(one,path.join(target,'sim-one'));
  runExperiment(two,path.join(target,'sim-two'));
  const read=(d,name)=>JSON.parse(fs.readFileSync(path.join(target,d,name),'utf8'));
  const report=compareOneTwo(read('sim-one','ue-0-result.json'),read('sim-two','ue-0-result.json'),
    read('sim-two','ue-1-result.json'),read('sim-one','shared-network.json'),read('sim-two','shared-network.json'),scenario);
  fs.writeFileSync(path.join(target,'one-vs-two-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`${scenario.scenarioId} (${scenario.abr.name}): one-vs-two status: ${report.status}; checks ${report.checks.filter(c=>c.passed).length}/${report.checks.length}.`);
  if (scenario.stallValidation) {
    console.log(`Required recovered stalls: ${scenario.stallValidation.minRecoveredStalls}; `+
      `simulated solo UE observed ${report.stallComparison.one.recovered.length}, `+
      `concurrent UEs observed ${report.stallComparison.twoUE0.recovered.length} and `+
      `${report.stallComparison.twoUE1.recovered.length}. Real-browser stall evidence is NOT validated yet.`);
  }
  console.log(`For browser comparison paste ${path.join(target,'configs/browser.json')} into the Browser Experiment JSON field and export the full session JSON.`);
  console.log(`Compare using node scripts/validation/compare-scenarios.mjs browser <browser-session.json> ${path.join(target,'sim-one')} ${path.join(target,'browser-vs-sim-report.json')} ${scenarioPath}`);
  if(report.status!=='invariants-passed')process.exitCode=1;
}catch(error){console.error(error.stack??String(error));process.exitCode=1;}

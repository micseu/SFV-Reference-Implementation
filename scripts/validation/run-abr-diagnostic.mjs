import fs from 'node:fs';
import path from 'node:path';
import {prepareScenarios} from './prepare-scenarios.mjs';
import {runExperiment} from '../run-experiment.mjs';
import {replaySessionDecisions} from './abr-diagnostics.mjs';

const scenarioFile=path.resolve(process.argv[2]??'scenarios/validation/scenario-b1-diagnostics-v1.json');
const target=path.resolve(process.argv[3]??'out/validation-b1-diagnostics');
try{
  const scenario=JSON.parse(fs.readFileSync(scenarioFile,'utf8'));
  scenario.diagnostics={abrDecisions:true};
  const {browser,one}=prepareScenarios(scenario);
  fs.mkdirSync(path.join(target,'configs'),{recursive:true});
  fs.writeFileSync(path.join(target,'configs/browser.json'),JSON.stringify(browser,null,2)+'\n');
  fs.writeFileSync(path.join(target,'configs/sim-one.json'),JSON.stringify(one,null,2)+'\n');
  runExperiment(one,path.join(target,'sim-one'));
  const sim=JSON.parse(fs.readFileSync(path.join(target,'sim-one/ue-0-result.json'),'utf8'));
  const replay=replaySessionDecisions(sim);
  fs.writeFileSync(path.join(target,'sim-replay-report.json'),JSON.stringify(replay,null,2)+'\n');
  console.log(`Simulated ${replay.total} diagnostic decisions; replay ${replay.passed}/${replay.total} (${replay.status}).`);
  console.log(`Run browser with ${path.join(target,'configs/browser.json')}; then use abr-diagnostics.mjs replay and compare on its exported session.`);
  if(replay.status!=='replay-passed')process.exitCode=1;
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}

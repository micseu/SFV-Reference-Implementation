import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareScenarios} from './prepare-scenarios.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

/** Generate versioned, identical-per-repeat B1/B2 JSON profiles for all three
 * experiments, without including browser exports or generated results in Git. */
export function prepareSupplementary(outputDirectory){
  if(!outputDirectory)throw new TypeError('Output directory is required');
  fs.mkdirSync(outputDirectory,{recursive:true});
  const files={};
  for(const [name,source] of [['B1','scenario-b1-diagnostics-v1.json'],
    ['B2','scenario-b2-stalling-v1.json']]){
    const scenario=JSON.parse(fs.readFileSync(path.join(root,'scenarios/validation',source),'utf8'));
    scenario.diagnostics={abrDecisions:true};
    const {browser}=prepareScenarios(scenario);
    const filename=path.join(outputDirectory,`${name}-browser.json`);
    fs.writeFileSync(filename,JSON.stringify(browser,null,2)+'\n');
    files[name]=filename;
  }
  return files;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(prepareSupplementary(process.argv[2]??path.join(root,'out/supplementary/configs')),null,2));}
  catch(error){console.error(error.stack??String(error));process.exitCode=1;}
}

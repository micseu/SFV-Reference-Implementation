import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const patch=path.join(root,'patches','dashjs-b1bde9f-CONSOLIDATED.patch');

test('the supported dash.js patch has the required hooks and valid patch syntax',()=>{
    const source=fs.readFileSync(patch,'utf8');
    assert.match(source,/e\.representationId !== request\.representation\.id/);
    assert.match(source,/const sameCachedResource = previous =>/);
    assert.match(source,/getSegmentRequestForTimeIdempotent/);
    assert.match(source,/externallyControlled/);
    assert.match(source,/executeCachedRequest/);
    assert.match(source,/parseSFVManifest/);
    assert.doesNotMatch(source,/\+.*e\.representationId !== request\.representationId\b/);
    assert.doesNotMatch(source,/\+.*if \(!rep\) throw/);
    const stat=execFileSync('git',['apply','--numstat',patch],{cwd:root,encoding:'utf8'});
    const files=stat.trim().split(/\r?\n/).map(line=>line.split('\t')[2]);
    assert.deepEqual(files, [
        'index.d.ts',
        'src/core/Settings.js',
        'src/dash/DashHandler.js',
        'src/streaming/StreamProcessor.js',
        'src/streaming/controllers/ScheduleController.js',
        'src/streaming/mediaplayer/CoreApi.js',
        'src/streaming/models/FragmentModel.js'
    ]);
});

test('standalone setup requires exactly one supported dash.js patch',()=>{
    const setup=fs.readFileSync(path.join(root,'docs','GETTING_STARTED.md'),'utf8');
    assert.match(setup,/Windows, Linux and macOS/);
    assert.match(setup,/prepare-dashjs\.mjs/);
    assert.match(setup,/--verify-installed/);
    assert.match(setup,/npm run ci:verify/);
    assert.deepEqual(fs.readdirSync(path.join(root,'patches')).filter(name=>name.endsWith('.patch')),
        ['dashjs-b1bde9f-CONSOLIDATED.patch']);
    for(const entry of ['src/index.js','scripts/run-experiment.mjs','scripts/run-simulation.mjs',
        'docs/reference/sfv_reference_architecture_summary.md',
        'docs/reference/sfv_technical_implementation_plan.md']){
        assert.equal(fs.existsSync(path.join(root,entry)),true,`${entry} must be available`);
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WORKBENCH_TOOLS} from './lib/workbench-client.mjs';
import {MODEL_WORKSPACE_TOOLS} from './lib/panel-tools.mjs';
const host=await readFile(new URL('./revit-addin/WorkbenchHost.cs',import.meta.url),'utf8');
test('project binding candidate stays closed at both host entries and absent from catalogs',()=>{
 assert.match(host,/ProjectBindingCandidateEnabled\s*=\s*false/);
 assert.match(host,/preparesProjectBinding\s*&&\s*!ProjectBindingCandidateEnabled/);
 assert.match(host,/operation == "bind_existing_project_parameter"[\s\S]*?if \(!ProjectBindingCandidateEnabled\)/);
 for(const name of ['revit_create_project_parameter','revit_create_shared_parameter','revit_bind_existing_project_parameter'])for(const tools of [WORKBENCH_TOOLS,MODEL_WORKSPACE_TOOLS])assert.equal(tools.some(x=>x.name===name),false);
});
test('atomic result binds host-generated token to original request and full snapshot',()=>{
 assert.match(host,/ProjectBindingCandidate\.Capture\(doc, projectPlan\)/);
 assert.match(host,/ProjectBindingApprovals\(\)\.Issue\(doc, projectSnapshot, projectPlan\.Scope, id\)/);
 assert.match(host,/ProjectBindingApprovals\(\)\.Consume\(doc, projectWritePlan\.Scope, projectOriginalRequest/);
});

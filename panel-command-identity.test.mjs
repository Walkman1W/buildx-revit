import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Only the production pure helper runs. These synthetic Windows command lines
// are data for CommandLineToArgvW: no process/listener query or service starts.
const root=fileURLToPath(new URL('.',import.meta.url));
const helper=path.join(root,'tools','PanelCommandIdentity.ps1');
const scope='D:\\Work\\BuildX', executable='C:\\Tools\\node.exe';
const entry=scope+'\\server.mjs',sourceEntry=scope+'\\source-panel.mjs';
const quoted=value=>'"'+value+'"';
const invoke=(script,extra='')=>quoted(executable)+' '+quoted(script)+(extra?' '+extra:'');
const fact=(Role,CommandMatches)=>({Role,CommandMatches});
const fixtures=[
  {id:'model_exact',command:invoke(entry),facts:[fact('model',true)]},
  {id:'source_exact',command:invoke(sourceEntry),facts:[fact('source',true)]},
  {id:'forward_slash_model',command:invoke('D:/Work/BuildX/server.mjs'),facts:[fact('model',true)]},
  {id:'forward_slash_source',command:invoke('D:/Work/BuildX/source-panel.mjs'),facts:[fact('source',true)]},
  {id:'absolute_dot_segments',command:invoke('D:\\Work\\BuildX\\.\\server.mjs'),facts:[fact('model',true)]},
  {id:'absolute_parent_segments',command:invoke('D:\\Work\\BuildX\\tmp\\..\\server.mjs'),facts:[fact('model',true)]},
  {id:'executable_path_format',command:'"C:/Tools/./node.exe" '+quoted(entry),facts:[fact('model',true)]},
  {id:'case_insensitive_paths',command:invoke('d:\\work\\buildx\\SERVER.MJS'),facts:[fact('model',true)]},
  {id:'quoted_unicode_spaces',root:'D:\\Work Space\\面板',command:invoke('D:\\Work Space\\面板\\server.mjs'),facts:[fact('model',true)]},
  {id:'unquoted_space_path_is_ambiguous',root:'D:\\Work Space\\面板',command:quoted(executable)+' D:\\Work Space\\面板\\server.mjs',facts:[fact('model',false)]},
  {id:'relative_dot_model',command:invoke('.\\server.mjs'),facts:[fact('model',false)]},
  {id:'relative_slash_source',command:invoke('./source-panel.mjs'),facts:[fact('source',false)]},
  {id:'bare_relative_model',command:invoke('server.mjs'),facts:[fact('model',false)]},
  {id:'relative_parent_model',command:invoke('..\\BuildX\\server.mjs'),facts:[fact('model',false)]},
  {id:'drive_relative_model',command:invoke('D:server.mjs'),facts:[fact('model',false)]},
  {id:'root_relative_model',command:invoke('\\Work\\BuildX\\server.mjs'),facts:[fact('model',false)]},
  {id:'foreign_root_same_basename',command:invoke('D:\\OtherApp\\server.mjs'),facts:[fact('model',false)]},
  {id:'node_flags_are_ambiguous',command:quoted(executable)+' --inspect '+quoted(entry),facts:[fact('model',false)]},
  {id:'extra_arguments_are_ambiguous',command:invoke(entry,'--fixture=must-not-be-returned'),facts:[fact('model',false)]},
  {id:'both_target_arguments',command:invoke(entry,quoted(sourceEntry)),facts:[fact('model',false),fact('source',false)]},
  {id:'arbitrary_wrapper_with_target_argument',command:invoke('D:\\OtherApp\\wrapper.mjs',quoted(entry)),facts:[fact('model',false)]},
  {id:'relative_executable_unknown',command:'node.exe '+quoted(entry),facts:[fact('model',false)]},
  {id:'argv0_does_not_match_process_executable',command:'"C:\\Other\\node.exe" '+quoted(entry),facts:[fact('model',false)]},
  {id:'foreign_direct_entry',command:invoke('D:\\OtherApp\\index.mjs','--fixture=must-not-be-returned'),facts:[]},
  {id:'eval_unknown',command:quoted(executable)+' --eval "import(\'hidden-module\')"',unknown:true},
  {id:'attached_eval_unknown',command:quoted(executable)+' -e"import(\'hidden-module\')"',unknown:true},
  {id:'attached_print_unknown',command:quoted(executable)+' -p"1+1"',unknown:true},
  {id:'attached_require_unknown',command:quoted(executable)+' -rfixture-preload index.mjs',unknown:true},
  {id:'import_unknown',command:quoted(executable)+' --import=fixture-preload index.mjs',unknown:true},
  {id:'non_node_metadata_unknown',executable:'C:\\Tools\\python.exe',command:invoke(entry),unknown:true},
  {id:'relative_scope_unknown',root:'.\\BuildX',command:invoke(entry),unknown:true},
  {id:'empty_command_unknown',command:'',unknown:true},
  {id:'oversize_command_unknown',command:'x'.repeat(32769),unknown:true},
  {id:'nul_command_unknown',command:invoke(entry)+'\0must-not-be-returned',unknown:true},
];
let observed;
if(process.platform==='win32'){
  const powershell=[process.env.PANEL_TEST_POWERSHELL,
    path.join(process.env.USERPROFILE||'','.cache','codex-runtimes','codex-primary-runtime','dependencies','native','powershell','pwsh.exe'),
    path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')].find(value=>value&&fs.existsSync(value));
  assert.ok(powershell,'an existing Windows PowerShell runtime is required; nothing is installed');
  const script=`$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. '${helper.replace(/'/g,"''")}'
$fixtures=[Console]::In.ReadToEnd() | ConvertFrom-Json
$rows=New-Object Collections.Generic.List[object]
foreach($item in $fixtures){
  try{
    $facts=@(Get-PanelCommandIdentity -Root ([string]$item.root) -ExecutablePath ([string]$item.executable) -CommandLine ([string]$item.command))
    $rows.Add([ordered]@{id=$item.id;ok=$true;facts=@($facts)})
  }catch{$rows.Add([ordered]@{id=$item.id;ok=$false;code=[string]$_.Exception.Message})}
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 5 -Compress))`;
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    input:JSON.stringify(fixtures.map(({id,command,root:fixedRoot=scope,executable:fixedExecutable=executable})=>({id,command,root:fixedRoot,executable:fixedExecutable}))),
    encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024});
  assert.equal(result.error,undefined,'pure helper must complete within its independent test deadline');
  assert.equal(result.status,0,'pure helper must exit normally: '+result.stderr);
  assert.doesNotMatch(result.stdout,/must-not-be-returned|hidden-module|fixture-preload/,'source command data is never returned');
  const rows=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  assert.equal(rows.length,fixtures.length);
  observed=new Map(rows.map(row=>[row.id,row]));
}
for(const fixture of fixtures){
  test('production Windows identity: '+fixture.id,{skip:process.platform!=='win32'},()=>{
    const result=observed.get(fixture.id);assert.ok(result);
    if(fixture.unknown){assert.equal(result.ok,false);assert.equal(result.code,'PANEL_COMMAND_IDENTITY_UNKNOWN');}
    else{assert.equal(result.ok,true);assert.deepEqual(result.facts,fixture.facts);}
  });
}

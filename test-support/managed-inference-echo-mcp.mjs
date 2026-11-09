import readline from 'node:readline';

const fixtureDocumentPath=process.argv[2];
if(!fixtureDocumentPath)throw new Error('Missing synthetic document path');
const document={path:fixtureDocumentPath,title:'fixture-document-title'};
const status={
  document,hostSession:'fixture-host-session',projectFingerprint:'fixture-project-fingerprint'
};
const tools=[
  {name:'fixture_echo',description:'Returns a synthetic workbench status',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'fixture_get_selection',description:'Returns a synthetic selection after checking the document',
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    inputSchema:{type:'object',properties:{expected_document:{type:'string'}},required:['expected_document'],additionalProperties:false}}
];

for await (const line of readline.createInterface({input:process.stdin})) {
  let m; try { m=JSON.parse(line); } catch { continue; }
  if (m.id === undefined) continue;
  let result;
  if(m.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(m.method==='tools/list') result={tools};
  else if(m.method==='tools/call' && m.params?.name==='fixture_echo') result={
    content:[{type:'text',text:JSON.stringify({...status,channel:'fixture-status-text'})}],
    structuredContent:{...status,channel:'fixture-status-structured'},
    _meta:{reference:'fixture-status-meta'},isError:false
  };
  else if(m.method==='tools/call' && m.params?.name==='fixture_get_selection') {
    const matches=m.params.arguments?.expected_document===fixtureDocumentPath;
    result={content:[{type:'text',text:matches
      ?'fixture-selection-document-matched: element 42'
      :'fixture-selection-document-mismatch'}],isError:!matches};
  }
  else if(m.method==='resources/list') result={resources:[]};
  else if(m.method==='resources/templates/list') result={resourceTemplates:[]};
  else result={};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
}

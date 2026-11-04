// Build-time application data, never a browser-supplied packing configuration.
// Raw input hashes live in each named manifest. Generated metadata contains no
// machine paths, environment values, accounts, credentials or dependency cache.
export const FRONTEND_COMPONENT_DEFINITION=Object.freeze({
  component:'buildx-customer-web-assets',stage:'frontend-component-only',
  manifest:'release/customer-web-assets.json',outputBase:'customer-web-assets',
  roles:Object.freeze(['entry','script','style','module']),exactPaths:null,entryPath:null,
  generatedFiles:Object.freeze({}),
});

const chatPaths=Object.freeze([
  'customer-server.mjs','customer-chat.README.zh-CN.md',
  'lib/codex-client-core.mjs','lib/local-runtimes.mjs','lib/panel-server-core.mjs',
  'lib/chat-session.mjs','lib/chat-context.mjs','lib/cad-document-path.mjs','lib/workbench-contracts.mjs',
  'lib/panel-accounts.mjs','lib/codex-confirmation.mjs','lib/customer-chat-profile.mjs',
  'lib/customer-chat.mjs','lib/buildx-runtime-config.mjs','lib/buildx-auth.mjs','lib/panel-audit.mjs',
  'prompts/buildx-customer-chat.zh-CN.md',
  'public/index.html','public/style.css','public/app.js','public/chat-view.mjs',
  'public/account.js','public/codex-account.js',
]);
const packageJson=JSON.stringify({
  name:'buildx-customer-chat-candidate',version:'0.1.0',private:true,type:'module',
  description:'BuildX local customer chat component candidate; not a commercial installer',
  scripts:{start:'node customer-server.mjs'},engines:{node:'24.19.0'},
  os:['win32'],cpu:['x64'],
  buildxCandidate:{component:'buildx-customer-chat-component',releaseReady:false,
    declaredModelAndSourceTools:0,installer:false,bundledExternalRuntimes:false},
},null,2)+'\n';
export const CUSTOMER_CHAT_COMPONENT_DEFINITION=Object.freeze({
  component:'buildx-customer-chat-component',stage:'customer-chat-component-only',
  manifest:'release/customer-chat-component.json',outputBase:'customer-chat',
  roles:Object.freeze(['entry','module','script','style','prompt','document']),
  exactPaths:chatPaths,entryPath:'customer-server.mjs',
  generatedFiles:Object.freeze({'package.json':packageJson}),
});

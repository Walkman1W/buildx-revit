import {confirmedWriteProfile} from './lib/confirmed-write-profile.mjs';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {CodexClient} from './lib/codex-client.mjs';
import {MODEL_SERVER_PROFILE} from './lib/panel-profile.mjs';
import {invokeWorkbench,invokeAtomicWorkbenchRead,combineWorkbenchTiming} from './lib/workbench-client.mjs';
import {createProjectHistory} from './lib/project-history.mjs';
import {createProjectKnowledge} from './lib/project-knowledge.mjs';
import {createProjectFilesComposition} from './lib/project-files-composition.mjs';
import {createProjectFilesStore} from './lib/project-files-store.mjs';
import {invokeModelCommand} from './lib/model-tool-dispatch.mjs';
import {createModelPermissionServices} from './lib/model-permission-services.mjs';
import {createFamilyCapabilityOwner} from './lib/family-capability-owner.mjs';
import {createGeneratedFileOwner} from './lib/generated-file-owner.mjs';
import {createGeneratedFileTransport} from './lib/generated-file-transport.mjs';
import {createGeneratedFileApproval} from './lib/generated-file-approval.mjs';
import {createPanelServer} from './lib/panel-server.mjs';
import {createPanelAudit} from './lib/panel-audit.mjs';
import {buildxRuntimeConfig} from './lib/buildx-runtime-config.mjs';
import {createPanelChatStore} from './lib/chat-store.mjs';
import {readInstallationConfiguration,resolveInstallationRuntimes} from './lib/installation-identity.mjs';
import {runPanelService} from './lib/server-lifecycle.mjs';
import {createAccessServices} from './lib/access-services.mjs';
import {createModelTerminalService} from './lib/model-terminal-service.mjs';
import {resolvePythonExecutable} from './lib/local-runtimes.mjs';
import {resolveBuildxPaths,resolveBuildxPanelPort} from './lib/buildx-paths.mjs';
import {CHAT_READ_RECEIPT_KEY_ENV,CHAT_READ_RECEIPT_PORT_ENV} from './lib/chat-read-receipts.mjs';
import {createInstalledLocalChatTools} from './lib/local-chat-tools-runtime.mjs';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const confirmedWrite=confirmedWriteProfile(ROOT);
const configuration=buildxRuntimeConfig();
const installation=await readInstallationConfiguration(ROOT);
const paths=resolveBuildxPaths(ROOT,installation);
const localChatTools=createInstalledLocalChatTools({paths,installation});
const nativeWebSearch=localChatTools!==null&&process.env.BUILDX_NATIVE_WEB_SEARCH==='1';
const lifecycle=createPanelAudit(paths.runtimeDirectory);
const history=createPanelChatStore({stateDirectory:paths.historyDirectory});
const projectKnowledgeFactory=options=>createProjectKnowledge({...options,...installation?{pythonExecutable:installation.pythonExecutable}:{}});
const {materialOpener,materialIndexFactory}=createProjectFilesComposition({...installation?{pythonExecutable:installation.pythonExecutable}:{}});
const materialStoreFactory=accountId=>createProjectFilesStore({stateDirectory:paths.historyDirectory,accountId});
const projectHistoryRoot=installation?.schemaVersion===2?paths.projectHistoryDirectory:process.env.BUILDX_PROJECT_HISTORY_ROOT;
if(projectHistoryRoot!==undefined&&(!path.isAbsolute(projectHistoryRoot)||!projectHistoryRoot))throw new Error('项目历史目录必须是已存在的独立绝对路径。');
const contains=(parent,child)=>{const relative=path.relative(path.resolve(parent),path.resolve(child));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(projectHistoryRoot!==undefined&&(contains(ROOT,projectHistoryRoot)||contains(projectHistoryRoot,ROOT)))throw new Error('项目历史目录不能与程序目录重叠。');
const projectHistoryFactory=projectHistoryRoot===undefined?null:accountId=>createProjectHistory({stateDirectory:projectHistoryRoot,accountId});
const profile=MODEL_SERVER_PROFILE;
const port=resolveBuildxPanelPort(installation),chatReadReceiptKey=randomBytes(32).toString('hex');
const onTiming=data=>lifecycle.audit('phase-timing.jsonl',data,true);
const timingControl=(control={})=>({...control,root:paths.workbenchRoot,onTiming:combineWorkbenchTiming(onTiming,control.onTiming)});
const familyCapabilityOwner=confirmedWrite?null:createFamilyCapabilityOwner();
const generatedFileOwner=createGeneratedFileOwner({dataRoot:paths.dataRoot});
const generatedFileTransport=createGeneratedFileTransport({workbenchRoot:paths.workbenchRoot});
const dynamicApprovalOwner=createGeneratedFileApproval({owner:generatedFileOwner,transport:generatedFileTransport});
const terminalWorkRoot=path.join(homedir(),'AppData','Local','BuildXTerminalWork');
const accessServices=createAccessServices({root:paths.dataRoot,programRoot:paths.programRoot,stateDirectory:path.join(paths.historyDirectory,'access-permissions'),terminalWorkRoot});
let terminalPython=installation?.pythonExecutable;
if(!installation&&process.platform==='win32')try{terminalPython=resolvePythonExecutable();}catch{}
const modelTerminal=createModelTerminalService({dataRoot:paths.dataRoot,workRoot:terminalWorkRoot,
  helperPath:path.join(paths.privateRuntimeDirectory,'terminal','BuildXTerminalHost.exe'),
  pythonExecutable:terminalPython,
  powershellExecutable:process.platform==='win32'&&process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):undefined});
const terminalAvailability=await modelTerminal.availability();
const runtimeDependencies={skillCatalogMode:configuration.mode,...familyCapabilityOwner?{familyCapabilityOwner}:{},
  spawn:(file,args,options)=>spawn(file,args,{...options,env:{...options.env,[CHAT_READ_RECEIPT_KEY_ENV]:chatReadReceiptKey,[CHAT_READ_RECEIPT_PORT_ENV]:String(port)}}),
  ...installation?{resolveRuntimes:()=>resolveInstallationRuntimes(installation)}:{}};
const app=createPanelServer({confirmedWrite,root:ROOT,dataRoot:paths.dataRoot,port,profile,chatReadReceiptKey,codex:new CodexClient(ROOT,{profile,generatedFiles:true,modelTerminal:!confirmedWrite&&terminalAvailability.available,localTools:localChatTools?.tools,nativeWebSearch},runtimeDependencies),accessServices,modelTerminal:confirmedWrite?null:modelTerminal,terminalAvailability:confirmedWrite?null:terminalAvailability,invokeWorkbench:(name,args,control={})=>invokeWorkbench(name,args,timingControl(control)),invokeAtomicContextRead:(name,args,control)=>invokeAtomicWorkbenchRead(name,args,timingControl(control)),invokeReadonlyCommand:(command,parameters,control)=>invokeModelCommand(command,parameters,timingControl(control)),modelPermissionServices:createModelPermissionServices({timingControl}),familyCapabilityOwner,generatedFileOwner,generatedFileTransport,dynamicApprovalOwner,localChatTools,materialOpener,materialIndexFactory,materialStoreFactory,projectKnowledgeFactory,projectHistoryFactory,auditLifecycle:lifecycle,historyStore:history,accountAuth:configuration.accountAuth,requireAccount:configuration.requireAccount,requireLicense:configuration.requireLicense,installationId:installation?.installationId??null});
await runPanelService({app,lifecycle,root:ROOT,runtimeDirectory:paths.runtimeDirectory});

import {createMaterialIndex} from './project-files.mjs';
import {createProjectFilesOpener} from './project-files-opener.mjs';

// One owner for both target launch and service shutdown, shared by the live
// entry and the default model composition.
export function createProjectFilesComposition({opener=createProjectFilesOpener(),pythonExecutable}={}){
  if(!Object.isFrozen(opener)||typeof opener.open!=='function'||typeof opener.close!=='function')throw new TypeError('Invalid library opener owner');
  return Object.freeze({materialOpener:opener,materialIndexFactory:()=>createMaterialIndex({openLocal:target=>opener.open(target),...(pythonExecutable?{pythonExecutable}:{})})});
}

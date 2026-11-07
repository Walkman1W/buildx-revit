import {createRequire} from 'node:module';import {createCandidateNativeRequestOwner} from '../lib/batch-native-request-owner-candidate.mjs';
const [dir,addon,id]=process.argv.slice(2),native=createRequire(import.meta.url)(addon),owner=createCandidateNativeRequestOwner(native,dir);owner.prepare(id,Buffer.from('process fixture'));console.log('ready');setInterval(()=>{},1000);

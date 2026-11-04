// Read aliases preserve Revit Int64 IDs as decimal strings. Fixed write tools
// accept safe JSON integers; unavailable IDs must never be rounded into a match.
export function commandElementId(value){
  if(typeof value==='string'&&!/^[1-9]\d*$/.test(value))return null;
  if(typeof value!=='number'&&typeof value!=='string')return null;
  const number=Number(value);return Number.isSafeInteger(number)&&number>0?number:null;
}
export const commandFormDocument=result=>typeof result?.hostSession==='string'&&result.hostSession&&
  typeof result.document?.title==='string'&&typeof result.document?.path==='string'
  ?{session:result.hostSession,title:result.document.title,path:result.document.path}:null;
export const sameCommandFormDocument=(a,b)=>Boolean(a&&b&&a.session===b.session&&a.title===b.title&&a.path===b.path);
export const commandFormOwner=snapshot=>JSON.stringify([snapshot?.accountEpoch,snapshot?.contextEpoch,snapshot?.commandIdentityKey,snapshot?.commandConversationId]);

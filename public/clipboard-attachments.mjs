// Clipboard/drop payloads remain files: the existing composer owns admission,
// byte limits and account/conversation binding before any asynchronous read.
export function hasTransferredFiles(transfer) {
  return Boolean(transfer && (Array.from(transfer.types || []).includes('Files') || transfer.files?.length));
}

export function clipboardImageFiles(transfer) {
  if (!transfer) return [];
  const items=Array.from(transfer.items || []).filter(item=>item.kind==='file' && /^image\//i.test(item.type || ''));
  const files=items.length ? items.map(item=>item.getAsFile()).filter(Boolean) : Array.from(transfer.files || []).filter(file=>/^image\//i.test(file.type || ''));
  return files.map((file,index)=>{
    // Browser screenshots sometimes have no filename. Give only those a name;
    // copied files retain their original names and bytes.
    if(typeof file.name==='string' && file.name.includes('.'))return file;
    const suffix=file.type==='image/png'?'png':file.type==='image/jpeg'?'jpg':'unsupported';
    return {name:'截图-'+(index+1)+'.'+suffix,type:file.type,size:file.size,arrayBuffer:()=>file.arrayBuffer()};
  });
}

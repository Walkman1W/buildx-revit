const REQUIRED_TEMPLATE_ID='metric-generic-model';

// Consume the production Host -> invokeWorkbench receipt. A successful list
// operation does not itself establish that the required template was readable.
export function assertFamilyTemplateBytePreflight(receipt){
  const reject=reason=>{throw new Error('Family template byte preflight failed: '+reason+'. Revit format, category and connector suitability remain unverified.');};
  if(receipt?.operation!=='family_templates'||receipt.value?.success!==true)
    reject('template observation was not confirmed');
  const templates=receipt.value.value?.templates;
  if(!Array.isArray(templates))reject('template observations are missing');
  const matches=templates.filter(template=>template?.template_id===REQUIRED_TEMPLATE_ID);
  if(matches.length!==1)reject('the required fixed template has no unique observation');
  const template=matches[0];
  if(template.state!=='BytesVerified'||template.issue!=='None')
    reject('the required template byte evidence was not verified');
  if(!Number.isSafeInteger(template.bytes)||template.bytes<=0||
      typeof template.sha256!=='string'||template.sha256.length!==64||!/^[a-f0-9]{64}$/i.test(template.sha256))
    reject('the required template byte length or SHA256 is invalid');
  return Object.freeze({
    template_id:REQUIRED_TEMPLATE_ID,bytes:template.bytes,sha256:template.sha256,
    bytes_verified:true,verification_scope:'template_bytes_only',
    native_format_validated:false,category_validated:false,
    connector_suitability_validated:false,
  });
}

const word=/^[a-z][a-z0-9_]{0,63}$/;
const exception=/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const guid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const diagnosticKeys=new Set(['stage','reason','exceptionType','saveAttempted','cleanupComplete','failureIds']);

export function readGeneratedFileDiagnostic(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!diagnosticKeys.has(key)))return null;
  const {stage,reason,exceptionType,saveAttempted,cleanupComplete,failureIds}=value;
  if(typeof stage!=='string'||!word.test(stage)||typeof reason!=='string'||!word.test(reason)||
    typeof exceptionType!=='string'||exceptionType.length>120||!exception.test(exceptionType)||
    typeof saveAttempted!=='boolean'||typeof cleanupComplete!=='boolean')return null;
  if(failureIds!==undefined&&(!Array.isArray(failureIds)||failureIds.length>16||failureIds.some(id=>typeof id!=='string'||!guid.test(id))))return null;
  return {stage,reason,exceptionType,saveAttempted,cleanupComplete,...failureIds?.length?{failureIds:[...failureIds]}:{}};
}

const phaseMessages=Object.freeze({
  prepare:'准备本地制作环境失败，请核对 Revit 宿主和文件目录。',
  template:'族模板校验失败，请核对 Revit 2024 的公制机械设备族模板。',
  new_document:'Revit 未能创建独立族文档，请核对族模板和 Revit 当前状态。',
  transaction_start:'Revit 未能启动族文档事务，请核对宿主状态。',
  family_parameters:'水泵族参数未能创建，请核对尺寸和模板内定义。',
  geometry:'水泵实体创建失败，请核对外形尺寸和管口位置。',
  geometry_regenerate:'Revit 无法重生成水泵实体，请核对尺寸和实体轮廓。',
  inlet_face:'Revit 未能定位进水口端面，请核对进水口尺寸和位置。',
  outlet_face:'Revit 未能定位出水口端面，请核对出水口尺寸和位置。',
  inlet_connector:'进水管口创建或绑定失败，请核对口径、流向和系统分类。',
  outlet_connector:'出水管口创建或绑定失败，请核对口径、流向和系统分类。',
  verify_before_save:'保存前校验失败，请核对族类别、实体尺寸和两个管口。',
  commit:'Revit 未能提交族文档事务，请核对原回执的失败代码。',
  save:'RFA 保存阶段发生问题，请核对原回执和产物目录。',
  reopen:'RFA 重开阶段发生问题，请核对原回执和产物目录。',
  verify_reopened:'RFA 重开后的校验未通过，请核对原回执。',
  cleanup:'族文档清理尚未确认，请先核对原回执。',
  open:'Revit 未能确认打开生成的族，请检查当前 Revit 窗口。'
});
const reasonMessages=Object.freeze({
  family_category_mismatch:'所用模板不是机械设备族。',
  unexpected_template_geometry:'所用模板已含几何或连接件。',
  family_type_missing:'未找到预期族类型。',
  type_parameter_value_mismatch:'已生成的类型参数值与批准的尺寸不同。',
  solid_geometry_missing:'未找到预期的水泵实体。',
  geometry_bounds_mismatch:'实测几何边界与批准的外形尺寸不同。',
  port_face_missing:'未找到匹配的圆形端面。',
  port_face_ambiguous:'存在多个匹配的圆形端面。',
  port_flow_unavailable:'连接件的流向参数不可用。',
  port_size_unavailable:'连接件的尺寸不能绑定到族参数。',
  port_count_mismatch:'连接件数量与批准的进、出两口不同。',
  port_origin_mismatch:'连接件位置与预期不同。',
  port_classification_mismatch:'连接件的系统分类与批准的类型不同。',
  port_normal_mismatch:'连接件法向与预期不同。',
  port_diameter_mismatch:'连接件口径与批准的尺寸不同。',
  port_flow_mismatch:'连接件流向与预期不同。'
});
const codeMessages=Object.freeze({
  PUMP_TEMPLATE_UNAVAILABLE:'本机 Revit 2024 的公制机械设备族模板不可用，请检查族模板安装和模板目录。',
  PUMP_BUILD_FAILED:'Revit 泵族构建阶段失败，原回执未提供更细原因。',
  PUMP_PRECHECK_FAILED:'Revit 未能准备独立机械设备族，请核对宿主和模板。',
  PUMP_HOST_CHANGED:'审批期间 Revit 宿主变化，制作未开始。',
  PUMP_APPROVAL_UNVERIFIED:'Revit 未能核实本次文件审批，制作未开始。'
});

export function generatedFileFailureView(result){
  const diagnostic=readGeneratedFileDiagnostic(result?.diagnostic);
  const phase=diagnostic&&Object.hasOwn(phaseMessages,diagnostic.stage)?phaseMessages[diagnostic.stage]:null;
  const reason=diagnostic&&Object.hasOwn(reasonMessages,diagnostic.reason)?reasonMessages[diagnostic.reason]:null;
  const detail=[phase,reason].filter(Boolean).join(' ');
  if(result?.status==='unknown')return {
    message:(detail?detail+' ':'')+'结果待核对，请检查原文件回执，避免重复生成。',
    ...(diagnostic?{diagnostic}:{})
  };
  const fallback=Object.hasOwn(codeMessages,result?.code)?codeMessages[result.code]:'文件未交付，请核对 Revit 宿主和输入。';
  return {message:detail||fallback,...(diagnostic?{diagnostic}:{})};
}

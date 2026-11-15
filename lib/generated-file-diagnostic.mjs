const word=/^[a-z][a-z0-9_]{0,63}$/;
const exception=/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const guid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const diagnosticKeys=new Set(['stage','reason','exceptionType','saveAttempted','cleanupComplete','failureIds','geometry']);
const geometryKeys=new Set(['port','expectedCenterMm','expectedNormal','expectedRadiusMm','sketchNormal','startOffsetMm','endOffsetMm','counts','candidates']);
const countKeys=new Set(['solids','instances','planar','referenced','aligned','coplanar','circular','matched']);
const candidateKeys=new Set(['normal','axisDeltaMm','radiusMm','hasReference','rejectedBy']);
const candidateRejections=new Set(['normal','plane','boundary','center','radius','reference','none']);
const plainRecord=value=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const knownKeys=(value,keys)=>plainRecord(value)&&Object.keys(value).every(key=>keys.has(key));
const inRange=(value,minimum,maximum)=>Number.isFinite(value)&&value>=minimum&&value<=maximum;
const mm=value=>inRange(value,-20000,20000);
const xyz=(value,check)=>Array.isArray(value)&&value.length===3&&check(value[0])&&check(value[1])&&check(value[2]);
const normal=value=>xyz(value,component=>inRange(component,-1.000001,1.000001));

function readPortCandidate(value){
  if(!knownKeys(value,candidateKeys))return null;
  const {normal:direction,axisDeltaMm,radiusMm,hasReference,rejectedBy}=value;
  if(!normal(direction)||!mm(axisDeltaMm)||radiusMm!==undefined&&!inRange(radiusMm,0,20000)||
    typeof hasReference!=='boolean'||!candidateRejections.has(rejectedBy))return null;
  return {normal:[...direction],axisDeltaMm,...(radiusMm===undefined?{}:{radiusMm}),hasReference,rejectedBy};
}

function readPortGeometry(value){
  if(!knownKeys(value,geometryKeys))return null;
  const {port,expectedCenterMm,expectedNormal,expectedRadiusMm,sketchNormal,startOffsetMm,endOffsetMm,counts,candidates}=value;
  if(!['inlet','outlet'].includes(port)||!xyz(expectedCenterMm,mm)||!normal(expectedNormal)||!inRange(expectedRadiusMm,0.01,600.001)||
    sketchNormal!==undefined&&!normal(sketchNormal)||startOffsetMm!==undefined&&!mm(startOffsetMm)||endOffsetMm!==undefined&&!mm(endOffsetMm)||
    !knownKeys(counts,countKeys)||Object.keys(counts).length===0||
    Object.values(counts).some(count=>!Number.isSafeInteger(count)||count<0||count>10000)||
    !Array.isArray(candidates)||candidates.length>8)return null;
  const observedCandidates=Array.from(candidates,readPortCandidate);
  if(observedCandidates.some(candidate=>!candidate))return null;
  return {port,expectedCenterMm:[...expectedCenterMm],expectedNormal:[...expectedNormal],expectedRadiusMm,
    ...(sketchNormal===undefined?{}:{sketchNormal:[...sketchNormal]}),
    ...(startOffsetMm===undefined?{}:{startOffsetMm}),...(endOffsetMm===undefined?{}:{endOffsetMm}),
    counts:{...counts},candidates:observedCandidates};
}

export function readGeneratedFileDiagnostic(value){
  if(!knownKeys(value,diagnosticKeys))return null;
  const {stage,reason,exceptionType,saveAttempted,cleanupComplete,failureIds}=value;
  if(typeof stage!=='string'||!word.test(stage)||typeof reason!=='string'||!word.test(reason)||
    typeof exceptionType!=='string'||exceptionType.length>120||!exception.test(exceptionType)||
    typeof saveAttempted!=='boolean'||typeof cleanupComplete!=='boolean')return null;
  if(failureIds!==undefined&&(!Array.isArray(failureIds)||failureIds.length>16||failureIds.some(id=>typeof id!=='string'||!guid.test(id))))return null;
  const geometry=readPortGeometry(value.geometry);
  return {stage,reason,exceptionType,saveAttempted,cleanupComplete,
    ...(failureIds?.length?{failureIds:[...failureIds]}:{}),...(geometry?{geometry}:{})};
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
  port_geometry_missing:'未取得该管口的实体几何。',
  port_planar_face_missing:'该管口实体没有可供连接的平面端面。',
  port_face_normal_mismatch:'端面法向与期望的管口朝向不同。',
  port_end_plane_mismatch:'端面位置与预期的管口末端截面不同。',
  port_circular_profile_mismatch:'端面的圆形边界、中心或半径未通过匹配。',
  port_reference_missing:'找到匹配端面，但 Revit 未返回可绑定的端面引用。',
  port_sketch_normal_mismatch:'草图实际法向与预期的管口朝向不同。',
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
const countLabels=Object.freeze({planar:'平面',referenced:'有引用',aligned:'法向匹配',coplanar:'共面',circular:'圆形',matched:'最终匹配'});

function portGeometrySummary(geometry){
  if(!geometry)return null;
  const {port,counts}=geometry;
  const observed=Object.entries(countLabels).filter(([key])=>Object.hasOwn(counts,key))
    .map(([key,label])=>label+' '+counts[key]);
  return observed.length?(port==='inlet'?'进水口':'出水口')+'端面筛查：'+observed.join('，')+'。':null;
}

export function generatedFileFailureView(result){
  const diagnostic=readGeneratedFileDiagnostic(result?.diagnostic);
  const phase=diagnostic&&Object.hasOwn(phaseMessages,diagnostic.stage)?phaseMessages[diagnostic.stage]:null;
  const reason=diagnostic&&Object.hasOwn(reasonMessages,diagnostic.reason)?reasonMessages[diagnostic.reason]:null;
  const detail=[phase,reason,portGeometrySummary(diagnostic?.geometry)].filter(Boolean).join(' ');
  if(result?.status==='unknown')return {
    message:(detail?detail+' ':'')+'结果待核对，请检查原文件回执，避免重复生成。',
    ...(diagnostic?{diagnostic}:{})
  };
  const fallback=Object.hasOwn(codeMessages,result?.code)?codeMessages[result.code]:'文件未交付，请核对 Revit 宿主和输入。';
  return {message:detail||fallback,...(diagnostic?{diagnostic}:{})};
}

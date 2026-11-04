import {commonWrite,elementId,elementIds,pointMm} from './workbench-contracts.mjs';

export const MODELLING_TEMPLATE_VERSION = 1;
const contract=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties:{...commonWrite,...properties},required:['expected_document',...required],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}});
const facingDirection={type:'object',properties:{x:{type:'number'},y:{type:'number'},z:{type:'number'}},required:['x','y','z'],additionalProperties:false,description:'Finite nonzero unitless XYZ direction in Revit internal axes. Must be horizontal and perpendicular to the host wall; magnitude is normalized. The tool flips facing only, without changing door handing.'};
export const MODELLING_TOOLS = [
  contract('revit_rotate_elements','Rotate 1–50 distinct elements around the vertical Z axis through axis_origin_mm. Supports only point or curve locations; rejects types, pinned elements and group members. Coordinates are absolute millimetres in Revit internal axes. Reads actual locations before and after rotation. Uses the existing C# executor and host transaction; default rollback, commit does not save.',{element_ids:elementIds,axis_origin_mm:pointMm,angle_degrees:{type:'number'}},['element_ids','axis_origin_mm','angle_degrees']),
  contract('revit_place_family_instance','Place one unhosted, nonstructural OneLevelBased family instance using actual symbol and level IDs. point_mm is an absolute position in Revit internal axes, including Z; the tool activates the symbol, applies level offset and reads back the actual position. Hosted, work-plane, line-based, adaptive and structural families are unsupported. Uses the existing C# executor and host transaction; default rollback, commit does not save.',{symbol_id:elementId,level_id:elementId,point_mm:pointMm},['symbol_id','level_id','point_mm']),
  contract('revit_place_door','Place one loaded OST_Doors OneLevelBasedHosted family symbol in a vertical straight Basic wall using actual symbol, wall and level IDs. point_mm is absolute millimetres in Revit internal axes: X/Y must lie on the wall location-line segment within 1 mm and Z within its vertical bounds. Optional facing_direction is unitless, horizontal and perpendicular to the wall; only facing is flipped. Reads back actual host, type, level, position, facing and built-in width/height (null when unavailable). Curtain, stacked, curved and slanted walls are unsupported. Uses the existing C# executor and host transaction; default rollback, commit does not save.',{symbol_id:elementId,wall_id:elementId,level_id:elementId,point_mm:pointMm,facing_direction:facingDirection},['symbol_id','wall_id','level_id','point_mm']),
  contract('revit_create_floor','Create one nonstructural, non-foundation rectangular horizontal floor without holes using actual floor type and level IDs. origin_mm is the lower X/Y corner; its absolute Z must equal level.project_elevation_mm plus offset_mm. width_mm and depth_mm are positive lengths along the internal X/Y axes. Reads actual area and offset. Uses the existing C# executor and host transaction; default rollback, commit does not save.',{floor_type_id:elementId,level_id:elementId,origin_mm:pointMm,width_mm:{type:'number',exclusiveMinimum:0},depth_mm:{type:'number',exclusiveMinimum:0},offset_mm:{type:'number',default:0}},['floor_type_id','level_id','origin_mm','width_mm','depth_mm'])
];
const names=new Set(MODELLING_TOOLS.map(tool=>tool.name));
export const isModellingTool=name=>names.has(name);

// Only typed numeric values enter C# source. This is a fixed template, not a
// security sandbox for arbitrary scripts; transaction ownership stays in Revit.
function number(value){
  if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Template requires a finite number');
  return `${Object.is(value,-0)?0:value}d`;
}
function id(value){
  if(!Number.isSafeInteger(value)||value<1)throw new Error('Template requires a positive safe element ID');
  return `${value}L`;
}
function point(value){
  if(!value||typeof value!=='object')throw new Error('Template requires a point');
  return `new XYZ(${number(value.x)} / 304.8d, ${number(value.y)} / 304.8d, ${number(value.z)} / 304.8d)`;
}
function direction(value){
  if(!value||typeof value!=='object'||[value.x,value.y,value.z].some(component=>typeof component!=='number'||!Number.isFinite(component)))throw new Error('Template requires a finite facing direction');
  const scale=Math.max(Math.abs(value.x),Math.abs(value.y),Math.abs(value.z));
  if(scale===0)throw new Error('Template requires a nonzero facing direction');
  const components=[value.x/scale,value.y/scale,value.z/scale],length=Math.hypot(...components);
  const normalized=components.map(component=>component/length);
  if(Math.abs(normalized[2])>0.000001)throw new Error('Door facing direction must be horizontal');
  return `new XYZ(${normalized.map(number).join(', ')})`;
}
const shared=`
object PointMm(XYZ p) { return new { x=p.X*304.8d, y=p.Y*304.8d, z=p.Z*304.8d }; }
void CheckPoint(XYZ p) { if (!XYZ.IsWithinLengthLimits(p)) throw new InvalidOperationException("Point is outside Revit design limits."); }
`;

function rotate(a){
  if(!Array.isArray(a.element_ids)||a.element_ids.length<1||a.element_ids.length>50||new Set(a.element_ids).size!==a.element_ids.length)throw new Error('Template requires 1–50 distinct element IDs');
  return `${shared}
var requestedIds = new long[] { ${a.element_ids.map(id).join(', ')} };
var origin = ${point(a.axis_origin_mm)};
CheckPoint(origin);
double requestedDegrees = ${number(a.angle_degrees)};
double appliedDegrees = requestedDegrees % 360d;
double radians = appliedDegrees * (Math.PI / 180d);
var ids = new List<ElementId>();
object ReadLocation(Element e) {
    var locationPoint = e.Location as LocationPoint;
    if (locationPoint != null) return new { element_id=e.Id.Value, kind="point", point_mm=PointMm(locationPoint.Point), rotation_radians=locationPoint.Rotation };
    var locationCurve = e.Location as LocationCurve;
    if (locationCurve != null && locationCurve.Curve != null && locationCurve.Curve.IsBound) return new { element_id=e.Id.Value, kind="curve", start_mm=PointMm(locationCurve.Curve.GetEndPoint(0)), end_mm=PointMm(locationCurve.Curve.GetEndPoint(1)) };
    throw new InvalidOperationException("Only point locations or bounded curve locations are supported: " + e.Id.Value);
}
var before = new List<object>();
foreach (long value in requestedIds) {
    var e = doc.GetElement(new ElementId(value));
    if (e == null || e is ElementType) throw new InvalidOperationException("Element is missing or is a type: " + value);
    if (e.Pinned || e.GroupId != ElementId.InvalidElementId) throw new InvalidOperationException("Pinned elements and group members cannot be rotated: " + value);
    before.Add(ReadLocation(e));
    ids.Add(e.Id);
}
if (Math.Abs(radians) > 0d) ElementTransformUtils.RotateElements(doc, ids, Line.CreateUnbound(origin, XYZ.BasisZ), radians);
doc.Regenerate();
var after = new List<object>();
foreach (var elementId in ids) {
    var e = doc.GetElement(elementId);
    if (e == null) throw new InvalidOperationException("Rotated element no longer exists: " + elementId.Value);
    after.Add(ReadLocation(e));
}
return new { tool="revit_rotate_elements", template_version=${MODELLING_TEMPLATE_VERSION}, element_ids=ids.Select(x=>x.Value).ToArray(), requested_angle_degrees=requestedDegrees, applied_angle_degrees=appliedDegrees, before=before, after=after };
`;
}

function placeFamily(a){
  return `${shared}
var symbol = doc.GetElement(new ElementId(${id(a.symbol_id)})) as FamilySymbol;
var level = doc.GetElement(new ElementId(${id(a.level_id)})) as Level;
var target = ${point(a.point_mm)};
CheckPoint(target);
if (symbol == null || symbol.Family == null) throw new InvalidOperationException("symbol_id must identify a loaded FamilySymbol.");
if (level == null) throw new InvalidOperationException("level_id must identify a Level.");
if (symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased) throw new InvalidOperationException("Only unhosted OneLevelBased families are supported.");
long categoryId = symbol.Category == null ? 0L : symbol.Category.Id.Value;
if (categoryId == (long)BuiltInCategory.OST_StructuralColumns || categoryId == (long)BuiltInCategory.OST_StructuralFraming || categoryId == (long)BuiltInCategory.OST_StructuralFoundation) throw new InvalidOperationException("Structural family categories are not supported by this tool.");
if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
var instance = doc.Create.NewFamilyInstance(target, symbol, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
if (instance == null || instance.Host != null) throw new InvalidOperationException("The requested unhosted family instance could not be created.");
var offset = instance.get_Parameter(BuiltInParameter.INSTANCE_ELEVATION_PARAM);
if (offset != null && !offset.IsReadOnly && offset.StorageType == StorageType.Double) {
    double requestedOffset = target.Z - level.ProjectElevation;
    if (Math.Abs(offset.AsDouble()-requestedOffset) > 0.000000001d && !offset.Set(requestedOffset) && Math.Abs(offset.AsDouble()-requestedOffset) > 0.000001d) throw new InvalidOperationException("Revit rejected the family elevation offset.");
}
doc.Regenerate();
var actual = doc.GetElement(instance.Id) as FamilyInstance;
var actualLocation = actual == null ? null : actual.Location as LocationPoint;
if (actualLocation == null || actualLocation.Point.DistanceTo(target) > 0.000001d) throw new InvalidOperationException("Family placement readback did not match the requested absolute position.");
if (actual.LevelId != level.Id || actual.GetTypeId() != symbol.Id) throw new InvalidOperationException("Family placement readback did not match the requested level/type.");
return new { tool="revit_place_family_instance", template_version=${MODELLING_TEMPLATE_VERSION}, created_ids=new long[] { actual.Id.Value }, readback=new { element_id=actual.Id.Value, symbol_id=actual.GetTypeId().Value, level_id=actual.LevelId.Value, point_mm=PointMm(actualLocation.Point), offset_mm=(actualLocation.Point.Z-level.ProjectElevation)*304.8d } };
`;
}

function placeDoor(a){
  const requestedFacing=a.facing_direction===undefined?'null':direction(a.facing_direction);
  return `${shared}
var symbol = doc.GetElement(new ElementId(${id(a.symbol_id)})) as FamilySymbol;
var wall = doc.GetElement(new ElementId(${id(a.wall_id)})) as Wall;
var level = doc.GetElement(new ElementId(${id(a.level_id)})) as Level;
var target = ${point(a.point_mm)};
XYZ requestedFacing = ${requestedFacing};
CheckPoint(target);
if (symbol == null || symbol.Family == null || symbol.Category == null || symbol.Category.Id.Value != (long)BuiltInCategory.OST_Doors) throw new InvalidOperationException("symbol_id must identify a loaded door FamilySymbol (OST_Doors).");
if (symbol.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBasedHosted) throw new InvalidOperationException("Only OneLevelBasedHosted door families are supported.");
if (wall == null || wall.WallType == null || wall.WallType.Kind != WallKind.Basic || wall.CrossSection != WallCrossSection.Vertical) throw new InvalidOperationException("wall_id must identify a vertical Basic wall.");
if (wall.GroupId != ElementId.InvalidElementId) throw new InvalidOperationException("Walls in model groups are not supported.");
if (level == null) throw new InvalidOperationException("level_id must identify a Level.");
var wallLocation = wall.Location as LocationCurve;
var wallLine = wallLocation == null ? null : wallLocation.Curve as Line;
const double positionTolerance = 1d / 304.8d;
const double directionTolerance = 0.000001d;
if (wallLine == null || !wallLine.IsBound || Math.Abs(wallLine.GetEndPoint(0).Z-wallLine.GetEndPoint(1).Z) > 0.000001d) throw new InvalidOperationException("Only straight horizontal wall location lines are supported.");
var start = wallLine.GetEndPoint(0);
var end = wallLine.GetEndPoint(1);
var wallAxis = (end-start).Normalize();
var inPlaneTarget = new XYZ(target.X, target.Y, start.Z);
double distanceAlong = (inPlaneTarget-start).DotProduct(wallAxis);
if (distanceAlong < 0d || distanceAlong > wallLine.Length || (inPlaneTarget-(start+wallAxis*distanceAlong)).GetLength() > positionTolerance) throw new InvalidOperationException("point_mm must lie on the wall location-line segment in plan (within 1 mm).");
var wallBounds = wall.get_BoundingBox(null);
if (wallBounds == null || target.Z < wallBounds.Min.Z-positionTolerance || target.Z > wallBounds.Max.Z+positionTolerance) throw new InvalidOperationException("point_mm.Z must be within the host wall vertical bounds.");
if (requestedFacing != null && Math.Abs(requestedFacing.DotProduct(wallAxis.CrossProduct(XYZ.BasisZ).Normalize())) < 1d-directionTolerance) throw new InvalidOperationException("facing_direction must be perpendicular to the wall.");
if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }
var instance = doc.Create.NewFamilyInstance(target, symbol, wall, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
if (instance == null) throw new InvalidOperationException("The hosted door instance could not be created.");
var sill = instance.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM);
double requestedOffset = target.Z-level.ProjectElevation;
if (sill != null && sill.StorageType == StorageType.Double && Math.Abs(sill.AsDouble()-requestedOffset) > 0.000000001d) {
    if (sill.IsReadOnly || (!sill.Set(requestedOffset) && Math.Abs(sill.AsDouble()-requestedOffset) > 0.000001d)) throw new InvalidOperationException("Revit rejected the door sill offset.");
}
doc.Regenerate();
var actual = doc.GetElement(instance.Id) as FamilyInstance;
if (actual == null || actual.Host == null || actual.Host.Id != wall.Id || actual.GetTypeId() != symbol.Id || actual.LevelId != level.Id) throw new InvalidOperationException("Door placement readback did not match the requested host/type/level.");
if (requestedFacing != null && actual.FacingOrientation.Normalize().DotProduct(requestedFacing) < 1d-directionTolerance) {
    if (!actual.CanFlipFacing || !actual.flipFacing()) throw new InvalidOperationException("The door cannot flip to the requested facing direction.");
    doc.Regenerate();
    actual = doc.GetElement(instance.Id) as FamilyInstance;
}
var actualLocation = actual == null ? null : actual.Location as LocationPoint;
if (actualLocation == null || actualLocation.Point.DistanceTo(target) > positionTolerance) throw new InvalidOperationException("Door placement readback did not match the requested absolute position within 1 mm.");
if (actual.Host == null || actual.Host.Id != wall.Id || actual.GetTypeId() != symbol.Id || actual.LevelId != level.Id) throw new InvalidOperationException("Door readback after facing change did not match the requested host/type/level.");
var actualFacing = actual.FacingOrientation.Normalize();
if (requestedFacing != null && actualFacing.DotProduct(requestedFacing) < 1d-directionTolerance) throw new InvalidOperationException("Door facing readback did not match facing_direction.");
double? ReadDimensionMm(FamilyInstance door, BuiltInParameter dimension) {
    var instanceDimension = door.get_Parameter(dimension);
    var typeDimension = door.Symbol.get_Parameter(dimension);
    foreach (var parameter in new Parameter[] { instanceDimension, typeDimension }) {
        if (parameter == null || parameter.StorageType != StorageType.Double || !parameter.HasValue) continue;
        double value = parameter.AsDouble()*304.8d;
        if (!Double.IsNaN(value) && !Double.IsInfinity(value) && value > 0d) return value;
    }
    return null;
}
return new { tool="revit_place_door", template_version=${MODELLING_TEMPLATE_VERSION}, created_ids=new long[] { actual.Id.Value }, readback=new { element_id=actual.Id.Value, wall_id=actual.Host.Id.Value, wall_type_id=actual.Host.GetTypeId().Value, symbol_id=actual.GetTypeId().Value, level_id=actual.LevelId.Value, point_mm=PointMm(actualLocation.Point), offset_mm=(actualLocation.Point.Z-level.ProjectElevation)*304.8d, facing_direction=new { x=actualFacing.X, y=actualFacing.Y, z=actualFacing.Z }, facing_flipped=actual.FacingFlipped, dimensions_mm=new { width=ReadDimensionMm(actual, BuiltInParameter.DOOR_WIDTH), height=ReadDimensionMm(actual, BuiltInParameter.DOOR_HEIGHT) } } };
`;
}

function createFloor(a){
  if(!(a.width_mm>0)||!(a.depth_mm>0))throw new Error('Template floor dimensions must be positive');
  if(!Number.isFinite(a.width_mm*a.depth_mm))throw new Error('Template floor area exceeds numeric range');
  return `${shared}
var floorType = doc.GetElement(new ElementId(${id(a.floor_type_id)})) as FloorType;
var level = doc.GetElement(new ElementId(${id(a.level_id)})) as Level;
var origin = ${point(a.origin_mm)};
double width = ${number(a.width_mm)} / 304.8d;
double depth = ${number(a.depth_mm)} / 304.8d;
double offsetValue = ${number(a.offset_mm ?? 0)} / 304.8d;
if (floorType == null || floorType.IsFoundationSlab) throw new InvalidOperationException("floor_type_id must identify a non-foundation FloorType.");
if (level == null) throw new InvalidOperationException("level_id must identify a Level.");
if (width <= app.ShortCurveTolerance || depth <= app.ShortCurveTolerance) throw new InvalidOperationException("Floor dimensions are below Revit short-curve tolerance.");
if (Math.Abs(origin.Z - (level.ProjectElevation + offsetValue)) > 0.000001d) throw new InvalidOperationException("origin_mm.Z must equal the level project elevation plus offset_mm.");
CheckPoint(origin);
var p0 = new XYZ(origin.X, origin.Y, level.ProjectElevation);
var p1 = p0 + new XYZ(width, 0d, 0d);
var p2 = p0 + new XYZ(width, depth, 0d);
var p3 = p0 + new XYZ(0d, depth, 0d);
foreach (var p in new XYZ[] { p0, p1, p2, p3 }) { CheckPoint(p); CheckPoint(p + new XYZ(0d, 0d, offsetValue)); }
var loop = new CurveLoop();
loop.Append(Line.CreateBound(p0,p1)); loop.Append(Line.CreateBound(p1,p2)); loop.Append(Line.CreateBound(p2,p3)); loop.Append(Line.CreateBound(p3,p0));
var floor = Floor.Create(doc, new List<CurveLoop> { loop }, floorType.Id, level.Id);
var offset = floor.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM);
if (offset == null || offset.StorageType != StorageType.Double) throw new InvalidOperationException("Floor height offset parameter is missing.");
if (Math.Abs(offset.AsDouble()-offsetValue) > 0.000000001d && (offset.IsReadOnly || (!offset.Set(offsetValue) && Math.Abs(offset.AsDouble()-offsetValue) > 0.000001d))) throw new InvalidOperationException("Revit rejected the floor height offset.");
doc.Regenerate();
var actual = doc.GetElement(floor.Id) as Floor;
var actualOffset = actual == null ? null : actual.get_Parameter(BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM);
var actualArea = actual == null ? null : actual.get_Parameter(BuiltInParameter.HOST_AREA_COMPUTED);
if (actualOffset == null || actualArea == null || actualArea.StorageType != StorageType.Double) throw new InvalidOperationException("Floor readback parameters are missing.");
double area = actualArea.AsDouble();
if (Double.IsNaN(area) || Double.IsInfinity(area) || area <= 0d || Math.Abs(area-width*depth) > Math.Max(0.00000001d,width*depth*0.00000001d)) throw new InvalidOperationException("Floor area readback did not match the requested rectangle.");
if (Math.Abs(actualOffset.AsDouble()-offsetValue) > 0.000001d || actual.LevelId != level.Id || actual.GetTypeId() != floorType.Id) throw new InvalidOperationException("Floor readback did not match the requested offset/level/type.");
return new { tool="revit_create_floor", template_version=${MODELLING_TEMPLATE_VERSION}, created_ids=new long[] { actual.Id.Value }, readback=new { element_id=actual.Id.Value, floor_type_id=actual.GetTypeId().Value, level_id=actual.LevelId.Value, offset_mm=actualOffset.AsDouble()*304.8d, area_mm2=area*304.8d*304.8d } };
`;
}

export function compileModellingTool(name,validatedArgs){
  if(!validatedArgs||typeof validatedArgs!=='object')throw new Error('Template arguments are required');
  switch(name){
    case 'revit_rotate_elements':return rotate(validatedArgs);
    case 'revit_place_family_instance':return placeFamily(validatedArgs);
    case 'revit_place_door':return placeDoor(validatedArgs);
    case 'revit_create_floor':return createFloor(validatedArgs);
    default:throw new Error('Unknown modelling tool');
  }
}

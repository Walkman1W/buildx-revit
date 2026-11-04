using System;
using System.Collections.Generic;

namespace RevitLocalCodex
{
    // Plain DTOs only. Native Revit geometry is consumed synchronously by the reader.
    internal sealed class CadReadError
    {
        public string code;
        public string message;
        public string path;
    }
    internal sealed class CadReadResult
    {
        public bool ok;
        public CadGeometryInventory value;
        public CadReadError error;
        public static CadReadResult Success(CadGeometryInventory inventory)
        {
            return new CadReadResult { ok = true, value = inventory };
        }
        public static CadReadResult Failed(string code, string message, string path = null, CadGeometryInventory partial = null)
        {
            return new CadReadResult { ok = false, value = partial,
                error = new CadReadError { code = code, message = message, path = path } };
        }
    }
    internal sealed class CadIssue
    {
        public string code;
        public string message;
        public string path;
    }
    internal sealed class CadImportSource
    {
        public string format = "revit-import-instance";
        public string documentPath;
        public string documentFingerprint;
        public long importElementId;
        public string importUniqueId;
        public string importTypeName;
        public bool isLinked;
        public string originalCadPath;
        public string originalCadUnits;
        public string geometryCoordinateSpace = "revit-model-internal-feet";
        public bool geometryInstanceTransformsApplied = true;
        // Metadata, NEVER an extra transform applied to already walked geometry.
        public double[] importTotalTransformMetadata;
    }
    internal sealed class CadUnits
    {
        public string sourceGeometry = "Revit_internal_feet";
        public double millimetresPerInternalUnit = 304.8;
        public string displayGeometry = "millimetres";
        public string originalCadUnits;
    }
    internal sealed class CadPrimitive
    {
        public int ordinal;
        public string type;
        public string geometryPath;
        public int? segmentIndex;
        public string layer;
        public long? graphicsStyleId;
        public double[] localFrom;
        public double[] localTo;
        public double[] modelFromInternal;
        public double[] modelToInternal;
        public double[] modelFromMm;
        public double[] modelToMm;
        public double[] cumulativeTransform;
        public List<CadIssue> issues = new List<CadIssue>();
    }
    internal sealed class CadCoverage
    {
        public int examinedObjectCount;
        public int retainedEntityCount;
        public int lineSegmentCount;
        public int unsupportedEntityCount;
        public int invalidLineCount;
        public int maxObservedDepth;
        public bool enumerationComplete = true;
        public bool interpretationComplete = true;
        public string stopReason;
        public int maxObjects = CadInventoryBuilder.MaxObjects;
        public int maxSegments = CadInventoryBuilder.MaxSegments;
        public int maxDepth = CadInventoryBuilder.MaxDepth;
        public int maxRetainedEntities = CadInventoryBuilder.MaxRetainedEntities;
    }
    internal sealed class CadGeometryInventory
    {
        public int schemaVersion = 1;
        public CadImportSource source;
        public CadUnits units = new CadUnits();
        public List<CadPrimitive> entities = new List<CadPrimitive>();
        public List<CadIssue> warnings = new List<CadIssue>();
        public CadCoverage coverage = new CadCoverage();
    }

    // Row-major affine matrices. Multiply(child) means this(parent) after child.
    // All coordinate math and unit conversion have one owner, independently testable.
    internal sealed class CadAffineTransform
    {
        private readonly double[] matrix;
        private CadAffineTransform(double[] entries)
        {
            if (entries == null || entries.Length != 16) throw new ArgumentException("An affine matrix requires 16 entries.");
            foreach (double value in entries) if (!Finite(value)) throw new ArgumentException("Transform entries must be finite.");
            if (entries[12] != 0 || entries[13] != 0 || entries[14] != 0 || entries[15] != 1)
                throw new ArgumentException("Only affine transforms are supported.");
            matrix = (double[])entries.Clone();
        }
        internal static bool Finite(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value); }
        internal static bool Point(double[] value)
        {
            return value != null && value.Length == 3 && Finite(value[0]) && Finite(value[1]) && Finite(value[2]);
        }
        public static CadAffineTransform Identity()
        {
            return new CadAffineTransform(new double[] { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 });
        }
        public static CadAffineTransform FromRevitComponents(double[] basisX, double[] basisY, double[] basisZ, double[] origin)
        {
            if (!Point(basisX) || !Point(basisY) || !Point(basisZ) || !Point(origin))
                throw new ArgumentException("Transform bases and origin require finite three-dimensional values.");
            return new CadAffineTransform(new double[] {
                basisX[0],basisY[0],basisZ[0],origin[0],
                basisX[1],basisY[1],basisZ[1],origin[1],
                basisX[2],basisY[2],basisZ[2],origin[2], 0,0,0,1 });
        }
        public CadAffineTransform Multiply(CadAffineTransform child)
        {
            if (child == null) throw new ArgumentNullException("child");
            var result = new double[16];
            for (int row = 0; row < 4; row++)
                for (int col = 0; col < 4; col++)
                    for (int k = 0; k < 4; k++) result[row * 4 + col] += matrix[row * 4 + k] * child.matrix[k * 4 + col];
            return new CadAffineTransform(result);
        }
        public double[] Apply(double[] point)
        {
            if (!Point(point)) throw new ArgumentException("A point requires three finite coordinates.");
            var output = new double[3];
            for (int row = 0; row < 3; row++)
            {
                output[row] = matrix[row * 4] * point[0] + matrix[row * 4 + 1] * point[1] + matrix[row * 4 + 2] * point[2] + matrix[row * 4 + 3];
                if (!Finite(output[row])) throw new ArgumentException("Transform application overflow.");
            }
            return output;
        }
        public double[] ToArray() { return (double[])matrix.Clone(); }
    }

    internal sealed class CadInventoryBuilder
    {
        // Retained/output budgets. Native Revit parsing time and allocation are not cancellable by these budgets.
        public const int MaxObjects = 5000;
        public const int MaxSegments = 10000;
        public const int MaxDepth = 16;
        private readonly CadGeometryInventory inventory;
        private bool halted;
        public bool IsStopped { get { return halted; } }
        public const int MaxRetainedEntities = MaxObjects + MaxSegments;
        public CadGeometryInventory Inventory { get { return inventory; } }
        public CadInventoryBuilder(CadImportSource source)
        {
            if (source == null) throw new ArgumentNullException("source");
            // The inventory owns a snapshot; caller mutation cannot rewrite provenance.
            var snapshot = new CadImportSource {
                format = source.format, documentPath = source.documentPath,
                documentFingerprint = source.documentFingerprint, importElementId = source.importElementId,
                importUniqueId = source.importUniqueId, importTypeName = source.importTypeName,
                isLinked = source.isLinked, originalCadPath = source.originalCadPath,
                originalCadUnits = source.originalCadUnits, geometryCoordinateSpace = source.geometryCoordinateSpace,
                geometryInstanceTransformsApplied = source.geometryInstanceTransformsApplied,
                importTotalTransformMetadata = source.importTotalTransformMetadata == null ? null : (double[])source.importTotalTransformMetadata.Clone()
            };
            inventory = new CadGeometryInventory { source = snapshot };
            inventory.units.originalCadUnits = source.originalCadUnits;
        }
        public void AddWarning(string code, string message, string path)
        {
            // Bounded diagnostics, with explicit omission rather than silent completeness.
            if (inventory.warnings.Count < 100)
                inventory.warnings.Add(new CadIssue { code = code, message = message, path = path });
            else if (inventory.warnings.Count == 100)
                inventory.warnings.Add(new CadIssue { code = "DIAGNOSTICS_LIMIT", message = "Additional diagnostic records omitted.", path = path });
        }
        public void MarkIncomplete(string code, string message, string path)
        {
            halted = true;
            inventory.coverage.enumerationComplete = false;
            inventory.coverage.interpretationComplete = false;
            if (inventory.coverage.stopReason == null) inventory.coverage.stopReason = code;
            AddWarning(code, message, path);
        }
        public bool ObserveObject(string path, int depth)
        {
            if (halted) return false;
            if (depth < 0 || depth > MaxDepth)
            { MarkIncomplete("DEPTH_LIMIT", "Unexamined geometry at the nesting-depth budget.", path); return false; }
            if (inventory.coverage.examinedObjectCount >= MaxObjects)
            { MarkIncomplete("OBJECT_LIMIT", "Unexamined geometry at the native-object budget.", path); return false; }
            inventory.coverage.examinedObjectCount++;
            inventory.coverage.maxObservedDepth = Math.Max(inventory.coverage.maxObservedDepth, depth);
            return true;
        }
        private CadPrimitive Create(string path, string type, string layer, long? graphicsStyleId)
        {
            var entity = new CadPrimitive { ordinal = inventory.entities.Count + 1,
                type = type, geometryPath = path, layer = layer, graphicsStyleId = graphicsStyleId };
            if (String.IsNullOrWhiteSpace(layer))
            {
                entity.issues.Add(new CadIssue { code = "MISSING_LAYER", message = "No direct GraphicsStyle category was resolved; no layer is inferred.", path = path });
                inventory.coverage.interpretationComplete = false;
            }
            inventory.entities.Add(entity);
            inventory.coverage.retainedEntityCount = inventory.entities.Count;
            return entity;
        }
        public void AddUnsupported(string path, string type, string layer, long? graphicsStyleId, string reason)
        {
            if (halted) return;
            if (inventory.entities.Count >= MaxRetainedEntities)
            { MarkIncomplete("ENTITY_LIMIT", "Unexamined geometry at the retained-entity budget.", path); return; }
            var entity = Create(path, type, layer, graphicsStyleId);
            entity.issues.Add(new CadIssue { code = "UNSUPPORTED_GEOMETRY", message = reason, path = path });
            inventory.coverage.unsupportedEntityCount++;
            inventory.coverage.interpretationComplete = false;
        }
        public bool AddLine(string path, int? segmentIndex, string layer, long? graphicsStyleId,
            CadAffineTransform transform, double[] localFrom, double[] localTo)
        {
            if (halted) return false;
            if (inventory.entities.Count >= MaxRetainedEntities)
            { MarkIncomplete("ENTITY_LIMIT", "Unexamined geometry at the retained-entity budget.", path); return false; }
            if (inventory.coverage.lineSegmentCount >= MaxSegments)
            { MarkIncomplete("SEGMENT_LIMIT", "Unexamined line segments at the retained-segment budget.", path); return false; }
            inventory.coverage.lineSegmentCount++;
            var entity = Create(path, "LINE", layer, graphicsStyleId);
            entity.segmentIndex = segmentIndex;
            entity.localFrom = CadAffineTransform.Point(localFrom) ? (double[])localFrom.Clone() : null;
            entity.localTo = CadAffineTransform.Point(localTo) ? (double[])localTo.Clone() : null;
            try
            {
                if (transform == null) throw new ArgumentException("A cumulative transform is required.");
                entity.cumulativeTransform = transform.ToArray();
                var from = transform.Apply(localFrom);
                var to = transform.Apply(localTo);
                var fromMm = new double[3]; var toMm = new double[3];
                for (int i = 0; i < 3; i++)
                {
                    fromMm[i] = from[i] * 304.8; toMm[i] = to[i] * 304.8;
                    if (!CadAffineTransform.Finite(fromMm[i]) || !CadAffineTransform.Finite(toMm[i]))
                        throw new ArgumentException("Millimetre conversion overflow.");
                }
                if (from[0] == to[0] && from[1] == to[1] && from[2] == to[2])
                    throw new ArgumentException("A zero-length segment is not an axis.");
                entity.modelFromInternal = from; entity.modelToInternal = to;
                entity.modelFromMm = fromMm; entity.modelToMm = toMm;
            }
            catch (ArgumentException error)
            {
                inventory.coverage.invalidLineCount++;
                inventory.coverage.interpretationComplete = false;
                entity.issues.Add(new CadIssue { code = "INVALID_AXIS", message = error.Message, path = path });
            }
            return true;
        }
    }
}
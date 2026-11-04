using System;
using System.Collections.Generic;
using System.Globalization;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Self-authored, read-only adapter. Invoke only in an existing Revit API context.
    // No transaction, document regeneration, selection, file access, or live-object retention.
    internal static class CadGeometryReader
    {
        // This guards the native PolyLine boundary before any point collection can be allocated.
        // The inventory owner independently enforces its total 10000-segment budget.
        private const int MaxPolylineCoordinates = CadInventoryBuilder.MaxSegments + 1;

        public static CadReadResult Read(Document document, ImportInstance import)
        {
            CadInventoryBuilder builder = null;
            ReadContext context = null;
            try
            {
                if (document == null) return CadReadResult.Failed("document_required", "An existing Revit document is required.");
                if (import == null) return CadReadResult.Failed("import_required", "An existing ImportInstance is required.");
                if (!document.IsValidObject) return CadReadResult.Failed("document_invalid", "The supplied Revit document is no longer valid.");
                if (!import.IsValidObject) return CadReadResult.Failed("import_invalid", "The supplied ImportInstance is no longer valid.");
                if (import.Document == null || !import.Document.Equals(document))
                    return CadReadResult.Failed("document_mismatch", "The ImportInstance does not belong to the supplied document.");

                var source = new CadImportSource
                {
                    documentPath = document.PathName,
                    importElementId = import.Id.Value,
                    importUniqueId = import.UniqueId,
                    isLinked = import.IsLinked,
                    // Revit geometry has already resolved import units. Original CAD units and
                    // the original file path cannot be derived from the model coordinates.
                    originalCadPath = null,
                    originalCadUnits = null,
                    format = "revit-import-instance",
                    geometryCoordinateSpace = "revit-model-internal-feet",
                    geometryInstanceTransformsApplied = true
                };
                if (String.IsNullOrEmpty(source.importUniqueId) || source.importElementId <= 0)
                    return CadReadResult.Failed("import_identity_unknown", "A stable ImportInstance element identity could not be read.");

                var metadataWarnings = new List<CadIssue>();
                ReadDocumentFingerprint(document, source, metadataWarnings);
                ReadImportTypeName(document, import, source, metadataWarnings);
                ReadTransformMetadata(import, source, metadataWarnings);
                // The model owner captures a detached source snapshot at construction.
                builder = new CadInventoryBuilder(source);
                context = new ReadContext(document, builder);
                foreach (CadIssue warning in metadataWarnings)
                    builder.AddWarning(warning.code, warning.message, warning.path);
                if (String.IsNullOrEmpty(source.documentPath))
                    builder.AddWarning("document_unsaved", "The document has no saved path; no path was invented.", "source/documentPath");
                builder.AddWarning("original_cad_units_unknown", "Coordinates below use Revit internal feet; the source CAD file units are unknown.", "source/originalCadUnits");
                builder.AddWarning("geometry_path_not_stable_id", "Geometry paths and segment indices identify this read only; reread after any CAD reload or change.", "geometry");
                builder.AddWarning("geometry_option_scope", "Coverage concerns only geometry returned by Revit with IncludeNonVisibleObjects=false, ComputeReferences=false and DetailLevel=Fine; it does not enumerate every entity in the original CAD file.", "geometry");

                context.CurrentPath = "geometry";
                using (var options = new Options())
                {
                    options.IncludeNonVisibleObjects = false;
                    options.ComputeReferences = false;
                    options.DetailLevel = ViewDetailLevel.Fine;
                    using (GeometryElement geometry = import.get_Geometry(options))
                    {
                        if (geometry == null)
                        {
                            builder.MarkIncomplete("geometry_unavailable", "Revit returned no geometry for this ImportInstance and these read options.", "geometry");
                        }
                        else
                        {
                            // Top-level geometry is already in the element/model context. Import
                            // GetTransform/GetTotalTransform must not be multiplied here again.
                            Visit(geometry, CadAffineTransform.Identity(), "geometry", 0, context);
                        }
                    }
                }
                return CadReadResult.Success(builder.Inventory);
            }
            catch (Exception error)
            {
                string path = context == null ? "source" : context.CurrentPath;
                if (builder != null)
                    builder.MarkIncomplete("read_interrupted", Describe(error), path);
                string code = IsExpectedApiFailure(error) ? "revit_read_failed" : "unexpected_revit_read_error";
                // Unexpected failures retain their full diagnostic stack instead of becoming a
                // successful empty inventory. No live Revit object escapes through this result.
                string diagnostic = IsExpectedApiFailure(error) ? Describe(error) : error.ToString();
                return CadReadResult.Failed(code, diagnostic, path, builder == null ? null : builder.Inventory);
            }
        }

        private static void ReadDocumentFingerprint(Document document, CadImportSource source, List<CadIssue> warnings)
        {
            try
            {
                source.documentFingerprint = document.ProjectInformation == null ? null : document.ProjectInformation.UniqueId;
                if (String.IsNullOrEmpty(source.documentFingerprint))
                    AddMetadataWarning(warnings, "document_fingerprint_unknown", "ProjectInformation.UniqueId was not available; no replacement identity was inferred.", "source/documentFingerprint");
            }
            catch (Exception error)
            {
                if (!IsExpectedApiFailure(error)) throw;
                AddMetadataWarning(warnings, "document_fingerprint_unavailable", Describe(error), "source/documentFingerprint");
            }
        }

        private static void ReadImportTypeName(Document document, ImportInstance import, CadImportSource source, List<CadIssue> warnings)
        {
            try
            {
                Element type = document.GetElement(import.GetTypeId());
                source.importTypeName = type == null ? null : type.Name;
                if (String.IsNullOrEmpty(source.importTypeName))
                    AddMetadataWarning(warnings, "import_type_name_unknown", "The import type name could not be resolved.", "source/importTypeName");
            }
            catch (Exception error)
            {
                if (!IsExpectedApiFailure(error)) throw;
                AddMetadataWarning(warnings, "import_type_name_unavailable", Describe(error), "source/importTypeName");
            }
        }

        private static void ReadTransformMetadata(ImportInstance import, CadImportSource source, List<CadIssue> warnings)
        {
            try
            {
                using (Transform total = import.GetTotalTransform())
                {
                    if (total == null)
                        AddMetadataWarning(warnings, "import_transform_unknown", "GetTotalTransform returned no metadata transform; it was not applied to geometry.", "source/importTotalTransformMetadata");
                    else
                        source.importTotalTransformMetadata = ToAffine(total).ToArray();
                }
            }
            catch (Exception error)
            {
                if (!IsExpectedApiFailure(error)) throw;
                AddMetadataWarning(warnings, "import_transform_metadata_unavailable", Describe(error), "source/importTotalTransformMetadata");
            }
        }

        private static void AddMetadataWarning(List<CadIssue> warnings, string code, string message, string path)
        {
            warnings.Add(new CadIssue { code = code, message = message, path = path });
        }
        private static void Visit(GeometryElement geometry, CadAffineTransform parent, string path, int depth, ReadContext context)
        {
            context.CurrentPath = path;
            int index = 0;
            using (IEnumerator<GeometryObject> iterator = geometry.GetEnumerator())
            {
                while (!context.Stopped)
                {
                    bool hasNext;
                    string childPath = path + "[" + index.ToString(CultureInfo.InvariantCulture) + "]";
                    context.CurrentPath = childPath;
                    try
                    {
                        hasNext = iterator.MoveNext();
                    }
                    catch (Exception error)
                    {
                        if (!IsExpectedApiFailure(error)) throw;
                        context.Builder.MarkIncomplete("geometry_enumeration_failed", Describe(error) + " Unexamined suffix starts at this geometry index.", childPath);
                        return;
                    }
                    if (!hasNext) return;
                    if (!context.Builder.ObserveObject(childPath, depth))
                    {
                        break;
                    }
                    try
                    {
                        GeometryObject item = iterator.Current;
                        if (item == null)
                        {
                            context.Builder.MarkIncomplete("null_geometry_object", "An observed geometry entry was null.", childPath);
                        }
                        else
                        {
                            VisitObject(item, parent, childPath, depth, context);
                        }
                    }
                    catch (Exception error)
                    {
                        if (!IsExpectedApiFailure(error)) throw;
                        context.Builder.MarkIncomplete("geometry_object_read_failed", Describe(error), childPath);
                    }
                    index++;
                }
                if (context.Stopped)
                    context.Builder.MarkIncomplete("geometry_unexamined_suffix", "Traversal stopped because " + (context.Builder.Inventory.coverage.stopReason ?? "unknown") + "; this container's remaining geometry indices have not been examined.", path + "[" + index.ToString(CultureInfo.InvariantCulture) + "..]");
            }
        }

        private static void VisitObject(GeometryObject item, CadAffineTransform parent, string path, int depth, ReadContext context)
        {
            var instance = item as GeometryInstance;
            if (instance != null)
            {
                if (depth >= CadInventoryBuilder.MaxDepth)
                {
                    context.Builder.MarkIncomplete("DEPTH_LIMIT", "This instance's symbol branch exceeds the nesting-depth budget and was not expanded.", path + "/symbol");
                    return;
                }
                if (context.Builder.Inventory.coverage.examinedObjectCount >= CadInventoryBuilder.MaxObjects)
                {
                    context.Builder.MarkIncomplete("OBJECT_LIMIT", "The native-object budget is exhausted; this instance's symbol branch was not expanded.", path + "/symbol");
                    return;
                }
                using (Transform nativeTransform = instance.Transform)
                {
                    CadAffineTransform cumulative = parent.Multiply(ToAffine(nativeTransform));
                    // This is the sole geometry-expansion path. Never mix GetInstanceGeometry
                    // with GetSymbolGeometry, and never transform symbol endpoints twice.
                    using (GeometryElement symbol = instance.GetSymbolGeometry())
                    {
                        if (symbol == null)
                            context.Builder.MarkIncomplete("symbol_geometry_unavailable", "GetSymbolGeometry returned no geometry; this branch is unexamined.", path + "/symbol");
                        else
                            Visit(symbol, cumulative, path + "/symbol", depth + 1, context);
                    }
                }
                return;
            }

            long? styleId;
            string layer = ReadDirectLayer(item, path, context, out styleId);
            var line = item as Line;
            if (line != null)
            {
                if (!line.IsBound)
                {
                    context.Builder.AddUnsupported(path, "Line", layer, styleId, "Unbounded lines have no finite endpoint pair.");
                    return;
                }
                AddSegment(path, null, layer, styleId, parent, line.GetEndPoint(0), line.GetEndPoint(1), context);
                return;
            }

            var polyline = item as PolyLine;
            if (polyline != null)
            {
                int count = polyline.NumberOfCoordinates;
                if (count < 2)
                {
                    context.Builder.AddUnsupported(path, "PolyLine", layer, styleId, "Polyline has fewer than two coordinates.");
                    return;
                }
                if (count > MaxPolylineCoordinates)
                {
                    context.Builder.AddUnsupported(path, "PolyLine", layer, styleId,
                        "Polyline has " + count.ToString(CultureInfo.InvariantCulture) + " coordinates; the bounded native read limit is " + MaxPolylineCoordinates.ToString(CultureInfo.InvariantCulture) + ". No coordinates from this branch were read.");
                    context.Builder.MarkIncomplete("polyline_coordinate_budget", "The entire oversized polyline remains unexamined. Traversal has stopped globally; remaining branches are not examined.", path);
                    return;
                }
                XYZ previous = polyline.GetCoordinate(0);
                for (int coordinateIndex = 1; coordinateIndex < count; coordinateIndex++)
                {
                    context.CurrentPath = path + "/segment[" + (coordinateIndex - 1).ToString(CultureInfo.InvariantCulture) + "]";
                    XYZ next = polyline.GetCoordinate(coordinateIndex);
                    AddSegment(path, coordinateIndex - 1, layer, styleId, parent, previous, next, context);
                    if (context.Stopped)
                    {
                        context.Builder.MarkIncomplete("polyline_unexamined_suffix", "Polyline segment indices from " + (coordinateIndex - 1).ToString(CultureInfo.InvariantCulture) + " through " + (count - 2).ToString(CultureInfo.InvariantCulture) + " were not retained; the current endpoint pair may already have been read.", path);
                        return;
                    }
                    previous = next;
                }
                return;
            }
            context.Builder.AddUnsupported(path, item.GetType().FullName, layer, styleId,
                "This adapter currently extracts bounded Line and PolyLine segments only; this object was observed but not converted.");
        }

        private static string ReadDirectLayer(GeometryObject item, string path, ReadContext context, out long? styleId)
        {
            styleId = null;
            try
            {
                ElementId id = item.GraphicsStyleId;
                if (id != null) styleId = id.Value;
                GraphicsStyle style = id == null || id == ElementId.InvalidElementId ? null : context.Document.GetElement(id) as GraphicsStyle;
                string name = style == null || style.GraphicsStyleCategory == null ? null : style.GraphicsStyleCategory.Name;
                if (!String.IsNullOrEmpty(name)) return name;
                context.Builder.AddWarning("source_layer_unknown", "No layer name could be resolved from this object's own GraphicsStyleId. Parent style was not inherited or guessed.", path);
            }
            catch (Exception error)
            {
                if (!IsExpectedApiFailure(error)) throw;
                context.Builder.AddWarning("source_layer_read_failed", Describe(error), path);
            }
            return null;
        }

        private static void AddSegment(string path, int? segmentIndex, string layer, long? styleId, CadAffineTransform transform, XYZ from, XYZ to, ReadContext context)
        {
            if (from == null || to == null)
            {
                context.Builder.MarkIncomplete("segment_endpoints_unavailable", "A segment endpoint was null.", path);
                return;
            }
            context.Builder.AddLine(path, segmentIndex, layer, styleId, transform, Point(from), Point(to));
        }

        private static CadAffineTransform ToAffine(Transform transform)
        {
            if (transform == null) throw new System.ArgumentException("A GeometryInstance transform was null.");
            return CadAffineTransform.FromRevitComponents(Point(transform.BasisX), Point(transform.BasisY), Point(transform.BasisZ), Point(transform.Origin));
        }

        private static double[] Point(XYZ point)
        {
            if (point == null) throw new System.ArgumentException("A geometry coordinate was null.");
            return new[] { point.X, point.Y, point.Z };
        }

        private static bool IsExpectedApiFailure(Exception error)
        {
            return error is Autodesk.Revit.Exceptions.InvalidObjectException ||
                error is Autodesk.Revit.Exceptions.InvalidOperationException ||
                error is Autodesk.Revit.Exceptions.ArgumentException ||
                error is System.InvalidOperationException ||
                error is System.ArgumentException;
        }

        private static string Describe(Exception error)
        {
            return error.GetType().FullName + ": " + error.Message;
        }

        private sealed class ReadContext
        {
            internal readonly Document Document;
            internal readonly CadInventoryBuilder Builder;
            internal bool Stopped { get { return Builder.IsStopped; } }
            internal string CurrentPath;
            internal ReadContext(Document document, CadInventoryBuilder builder)
            {
                Document = document;
                Builder = builder;
                CurrentPath = "source";
            }
        }
    }
}
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // One ExternalEvent callback owns the complete visual operation. The user's
    // view is never activated, isolated, reoriented or zoomed by this owner.
    // Temporary inspection views and their transaction group are our resources;
    // image files are independent evidence and deliberately survive rollback.
    internal sealed class VisualInspection
    {
        internal static readonly string[] Operations = { "capture_view", "inspect_elements", "restore_visual_session" };
        private const long ImageBytes = 2 * 1024 * 1024, TotalImageBytes = 4 * 1024 * 1024;
        private const long StorageBytes = 128L * 1024 * 1024;
        private const int StorageImages = 512, StorageEntries = 4096;
        private readonly string hostSession, root;
        private PendingInspection pending;

        private sealed class OwnedView
        {
            internal long Id;
            internal string UniqueId;
        }
        private sealed class PendingInspection
        {
            internal readonly string Handle = Guid.NewGuid().ToString("D");
            internal Document Document;
            internal string Path, Title;
            internal TransactionGroup Group;
            internal readonly List<OwnedView> Views = new List<OwnedView>();
            internal string LastDiagnostic;
        }
        private sealed class ImageReceipt
        {
            public string artifact_id, request_id, path, sha256, view_name, orientation, captured_at;
            public long bytes, view_id, source_view_id;
            public int width, height;
            public bool view_is_temporary;
        }
        private sealed class VisualFailure : Exception
        {
            internal readonly string Code;
            internal VisualFailure(string code, string message) : base(message) { Code = code; }
        }

        internal VisualInspection(string hostSession, string root)
        {
            this.hostSession = hostSession; this.root = Path.GetFullPath(root);
        }
        internal static bool IsOperation(string operation) { return Operations.Contains(operation, StringComparer.Ordinal); }
        internal bool CleanupPending { get { return pending != null; } }

        internal object Execute(UIApplication uiapp, string operation, Dictionary<string, object> args, string requestId)
        {
            Guid parsedId;
            if (!Guid.TryParseExact(requestId, "D", out parsedId)) throw new InvalidOperationException("Invalid visual request identity.");
            if (operation == "restore_visual_session")
            {
                Fields(args, "expected_document", "session_handle");
                string handle = RequiredText(args, "session_handle", 36);
                if (pending == null || !String.Equals(pending.Handle, handle, StringComparison.Ordinal))
                    throw new InvalidOperationException("No owned visual cleanup session matches this handle.");
                RequireSameDocument(uiapp, pending);
                bool restored = RestoreOwned(pending);
                return Result(operation, uiapp.ActiveUIDocument.Document, new long[0], new long[0], new List<ImageReceipt>(),
                    restored, restored ? "restored" : "cleanup_pending", restored ? "VISUAL_RESTORED" : "VISUAL_RESTORE_PENDING",
                    restored ? null : pending.LastDiagnostic, restored ? "restored" : "pending", restored ? null : pending.Handle, true);
            }
            if (pending != null)
                return Result(operation, uiapp.ActiveUIDocument.Document,
                    operation == "inspect_elements" ? ElementIds(args, "element_ids", 1, 50, true) : new long[0],
                    operation == "inspect_elements" ? ElementIds(args, "context_element_ids", 0, 100, false) : new long[0], new List<ImageReceipt>(), false,
                    "cleanup_pending", "VISUAL_RESTORE_REQUIRED", "Restore the retained owned visual session before another capture.", "pending", pending.Handle, true);

            Document doc = uiapp.ActiveUIDocument.Document;
            View originalActiveView = doc.ActiveView;
            long originalActiveId = originalActiveView.Id.Value;
            var images = new List<ImageReceipt>();
            long[] targetIds = new long[0], contextIds = new long[0];
            string outcome = "completed", code = "VISUAL_CAPTURED", diagnostic = null, restoration = "unchanged", handleResult = null;
            bool success = false;
            PendingInspection owned = null;
            try
            {
                int pixels = OptionalInteger(args, "pixel_size", 1280, 256, 2048);
                ThrowIfCancelled(requestId);
                if (operation == "capture_view")
                {
                    Fields(args, "expected_document", "view_id", "pixel_size");
                    View view = ViewByArgument(doc, args, "view_id", originalActiveView);
                    RequireStorageCapacity(1, ImageBytes);
                    images.Add(ExportImage(doc, view, view.Id.Value, false, "current", pixels, requestId, TotalImageBytes));
                    ThrowIfCancelled(requestId);
                    success = true;
                }
                else if (operation == "inspect_elements")
                {
                    Fields(args, "expected_document", "element_ids", "context_element_ids", "source_view_id", "orientations", "pixel_size");
                    View sourceView = ViewByArgument(doc, args, "source_view_id", originalActiveView);
                    targetIds = ElementIds(args, "element_ids", 1, 50, true);
                    contextIds = ElementIds(args, "context_element_ids", 0, 100, false);
                    string[] orientations = Orientations(args);
                    // Admit the complete requested group before creating any view.
                    // Previous native PNGs and partial staging output remain evidence;
                    // capacity is never recovered by deleting them automatically.
                    RequireStorageCapacity(orientations.Length, Math.Min(TotalImageBytes, orientations.Length * ImageBytes));
                    var targets = targetIds.Select(id => RequiredElement(doc, id)).ToList();
                    var context = contextIds.Select(id => RequiredElement(doc, id)).ToList();
                    var visibleIds = targets.Concat(context).GroupBy(element => element.Id.Value).Select(group => group.First().Id).ToList();
                    BoundingBoxXYZ bounds = ElementBounds(targets);
                    ViewFamilyType viewType;
                    using (var collector = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)))
                        viewType = collector.Cast<ViewFamilyType>().FirstOrDefault(type => type.ViewFamily == ViewFamily.ThreeDimensional);
                    if (viewType == null) throw new VisualFailure("VISUAL_VIEW_TYPE_MISSING", "The document has no 3D view family type.");
                    owned = new PendingInspection { Document = doc, Path = doc.PathName, Title = doc.Title,
                        Group = new TransactionGroup(doc, "BuildX temporary visual inspection") };
                    pending = owned;
                    if (owned.Group.Start() != TransactionStatus.Started)
                        throw new VisualFailure("VISUAL_GROUP_NOT_STARTED", "Could not start the owned visual transaction group.");
                    long totalBytes = 0;
                    foreach (string orientation in orientations)
                    {
                        ThrowIfCancelled(requestId);
                        View3D inspectionView = null;
                        using (var transaction = new Transaction(doc, "BuildX inspection view: " + orientation))
                        {
                            if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start the inspection view transaction.");
                            try
                            {
                                inspectionView = View3D.CreateIsometric(doc, viewType.Id);
                                // Record provenance immediately, before subsequent API setters can fail.
                                owned.Views.Add(new OwnedView { Id = inspectionView.Id.Value, UniqueId = inspectionView.UniqueId });
                                inspectionView.Name = "B" + Guid.NewGuid().ToString("N");
                                inspectionView.DetailLevel = ViewDetailLevel.Fine;
                                inspectionView.DisplayStyle = DisplayStyle.Shading;
                                CopyPhase(sourceView, inspectionView, BuiltInParameter.VIEW_PHASE);
                                CopyPhase(sourceView, inspectionView, BuiltInParameter.VIEW_PHASE_FILTER);
                                OrientAndFrame(inspectionView, bounds, orientation);
                                inspectionView.IsolateElementsTemporary(visibleIds);
                                doc.Regenerate();
                                CropToBounds(inspectionView, bounds);
                                if (transaction.Commit() != TransactionStatus.Committed)
                                    throw new VisualFailure("VISUAL_VIEW_NOT_COMMITTED", "Revit did not commit the temporary inspection view.");
                            }
                            catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                        }
                        // ExportImage requires a finished transaction; the outer group
                        // remains ours until all frames and final restoration finish.
                        ThrowIfCancelled(requestId);
                        ImageReceipt image = ExportImage(doc, inspectionView, sourceView.Id.Value, true, orientation, pixels, requestId, TotalImageBytes - totalBytes);
                        images.Add(image); totalBytes += image.bytes;
                        ThrowIfCancelled(requestId);
                    }
                    success = true;
                }
                else throw new InvalidOperationException("Unknown visual operation.");
            }
            catch (Exception error)
            {
                VisualFailure failure = error as VisualFailure;
                success = false; code = failure == null ? "VISUAL_CAPTURE_FAILED" : failure.Code;
                outcome = code == "VISUAL_CANCELLED" ? "cancelled" : images.Count > 0 ? "partial" : "failed";
                diagnostic = error.GetType().Name + ": " + error.Message;
            }
            finally
            {
                // Cancellation never suppresses final cleanup. Retain ownership on
                // failure, including a Dispose failure after rollback succeeded.
                if (owned != null)
                {
                    bool restored = RestoreOwned(owned);
                    restoration = restored ? "restored" : "pending";
                    handleResult = restored ? null : owned.Handle;
                    if (!restored) { success = false; outcome = "cleanup_pending"; code = "VISUAL_RESTORE_PENDING"; diagnostic = owned.LastDiagnostic; }
                }
            }
            bool sourceUnchanged = false;
            try
            {
                var source = new BuildX.FamilyRevit.RevitProjectDocumentSource(System.Threading.Thread.CurrentThread.ManagedThreadId);
                sourceUnchanged = source.SameOpenDocument(doc, uiapp.ActiveUIDocument.Document) == true && doc.ActiveView.Id.Value == originalActiveId;
            }
            catch { }
            if (!sourceUnchanged) { success = false; outcome = "source_state_unknown"; code = "VISUAL_SOURCE_STATE_UNKNOWN"; }
            return Result(operation, doc, targetIds, contextIds, images, success, outcome, code, diagnostic, restoration, handleResult, sourceUnchanged);
        }

        private object Result(string operation, Document doc, long[] targets, long[] context, List<ImageReceipt> images,
            bool success, string outcome, string code, string diagnostic, string restoration, string handle, bool unchanged)
        {
            return new { schema_version = 1, operation, host_session = hostSession,
                document = new { title = doc.Title, path = doc.PathName }, target_ids = targets, context_ids = context,
                success, outcome, code, diagnostic, cleanup_pending = handle != null, images = images.ToArray(),
                restoration = new { status = restoration, session_handle = handle, source_view_unchanged = unchanged },
                notes = new[] { "Images are retained local evidence, independent of model rollback.",
                    "Inspection images use a dedicated temporary 3D view with standard display settings and source phase; they do not reproduce all source-view overrides.",
                    "Only target bounds plus framing margin are shown; context elements can be clipped. Visual appearance alone does not establish dimensions, connections or precise collisions." } };
        }

        private bool RestoreOwned(PendingInspection owner)
        {
            if (!Object.ReferenceEquals(pending, owner)) return false;
            string diagnostic = null;
            bool groupReleased = owner.Group == null;
            if (owner.Group != null)
            {
                try
                {
                    // A previous callback may already have been rolled back by Revit.
                    if (owner.Group.GetStatus() == TransactionStatus.Started)
                    {
                        TransactionStatus status = owner.Group.RollBack();
                        if (status != TransactionStatus.RolledBack) diagnostic = "Transaction group rollback returned " + status;
                    }
                }
                catch (Exception error) { diagnostic = "Transaction group status/rollback: " + error.GetType().Name + ": " + error.Message; }
                try { owner.Group.Dispose(); owner.Group = null; groupReleased = true; }
                catch (Exception error) { diagnostic = "Transaction group disposal: " + error.GetType().Name + ": " + error.Message; }
            }
            try
            {
                var remaining = OwnedRemainingViews(owner);
                // If Revit ended the group between callbacks but retained an owned
                // view, only that exact UniqueId may be removed. Never delete by an
                // old numeric ID that may now identify someone else's element.
                if (remaining.Count > 0 && groupReleased && !owner.Document.IsReadOnly && !owner.Document.IsModifiable)
                {
                    using (var transaction = new Transaction(owner.Document, "BuildX remove retained inspection views"))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start owned view cleanup.");
                        try
                        {
                            owner.Document.Delete(remaining.Select(view => view.Id).ToList());
                            if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Owned view cleanup was not committed.");
                        }
                        catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                    }
                    remaining = OwnedRemainingViews(owner);
                }
                if (groupReleased && remaining.Count == 0) { pending = null; return true; }
                if (remaining.Count > 0) diagnostic = "Owned inspection views remain; retry restoration using this session handle.";
            }
            catch (Exception error) { diagnostic = "Owned view restoration: " + error.GetType().Name + ": " + error.Message; }
            owner.LastDiagnostic = diagnostic ?? "The owned visual cleanup resource is still retained.";
            return false;
        }

        private static List<View> OwnedRemainingViews(PendingInspection owner)
        {
            var source = new BuildX.FamilyRevit.RevitProjectDocumentSource(System.Threading.Thread.CurrentThread.ManagedThreadId);
            if (source.SameOpenDocument(owner.Document, owner.Document) != true) throw new InvalidOperationException("Owned document identity is no longer valid.");
            var remaining = new List<View>();
            foreach (OwnedView owned in owner.Views)
            {
                Element element = owner.Document.GetElement(owned.UniqueId);
                if (element == null) continue;
                View view = element as View;
                if (view == null || view.Id.Value != owned.Id || !String.Equals(view.UniqueId, owned.UniqueId, StringComparison.Ordinal))
                    throw new InvalidOperationException("Owned inspection view identity is unresolved.");
                remaining.Add(view);
            }
            return remaining;
        }

        private static void RequireSameDocument(UIApplication uiapp, PendingInspection owner)
        {
            Document current = uiapp.ActiveUIDocument == null ? null : uiapp.ActiveUIDocument.Document;
            var source = new BuildX.FamilyRevit.RevitProjectDocumentSource(System.Threading.Thread.CurrentThread.ManagedThreadId);
            if (current == null || source.SameOpenDocument(owner.Document, current) != true)
                throw new InvalidOperationException("Return to the original owned document before restoring the visual session.");
        }

        private ImageReceipt ExportImage(Document doc, View view, long sourceViewId, bool temporary, string orientation,
            int pixels, string requestId, long remainingBytes)
        {
            ThrowIfCancelled(requestId);
            if (remainingBytes < 1) throw new VisualFailure("VISUAL_IMAGE_BUDGET", "The image group reached its 4 MiB budget.");
            RequireStorageCapacity(1, Math.Min(ImageBytes, remainingBytes));
            string artifactId = Guid.NewGuid().ToString("D");
            string requestDirectory = Path.Combine(root, "visual-captures", hostSession, requestId);
            string stagingDirectory = Path.Combine(requestDirectory, "s" + Guid.Parse(artifactId).ToString("N"));
            // Only generated descendants are admitted, and none may redirect
            // output through a directory junction or symbolic link.
            OwnedDirectory(root);
            OwnedDirectory(Path.Combine(root, "visual-captures"));
            OwnedDirectory(Path.Combine(root, "visual-captures", hostSession));
            OwnedDirectory(requestDirectory); OwnedDirectory(stagingDirectory);
            FitDirectionType fit = FitDirectionType.Horizontal;
            try
            {
                BoundingBoxUV outline = view.Outline;
                if (outline != null && outline.Max.V - outline.Min.V > outline.Max.U - outline.Min.U) fit = FitDirectionType.Vertical;
            }
            catch { /* Export still verifies the actual PNG dimensions below. */ }
            var options = new ImageExportOptions {
                ExportRange = ExportRange.SetOfViews, ZoomType = ZoomFitType.FitToPage, PixelSize = pixels,
                FitDirection = fit, ImageResolution = ImageResolution.DPI_150,
                HLRandWFViewsFileType = ImageFileType.PNG, ShadowViewsFileType = ImageFileType.PNG,
                FilePath = Path.Combine(stagingDirectory, "r") };
            options.SetViewsAndSheets(new List<ElementId> { view.Id });
            // Revit controls its generated suffix; this conservative preflight cannot prove its final name.
            if (options.FilePath.Length + view.Name.Length + 32 > 240)
                throw new VisualFailure("VISUAL_EXPORT_PATH_TOO_LONG", "The export path and view name leave insufficient room for the Revit-generated filename; no export was attempted.");
            try { doc.ExportImage(options); }
            catch (PathTooLongException) { throw new VisualFailure("VISUAL_EXPORT_PATH_TOO_LONG", "Revit could not export using the generated path; generated files, if any, were retained."); }
            string[] actual = Directory.GetFiles(stagingDirectory, "*.png", SearchOption.TopDirectoryOnly);
            if (actual.Length != 1) throw new VisualFailure("VISUAL_IMAGE_FILE_UNCONFIRMED", "Revit did not produce exactly one PNG for the requested view.");
            FileInfo file = new FileInfo(actual[0]);
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0 || file.Length < 1 || file.Length > Math.Min(ImageBytes, remainingBytes))
                throw new VisualFailure("VISUAL_IMAGE_BUDGET", "The generated PNG exceeds the per-image 2 MiB or group 4 MiB budget; generated files were retained.");
            int width, height;
            string digest;
            using (var stream = new FileStream(actual[0], FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                using (Image image = Image.FromStream(stream, false, true))
                {
                    width = image.Width; height = image.Height;
                    if (width < 1 || height < 1 || width > 4096 || height > 4096 || (long)width * height > 16000000)
                        throw new VisualFailure("VISUAL_IMAGE_DIMENSIONS", "The generated PNG dimensions exceed the image input budget.");
                }
                stream.Position = 0;
                using (SHA256 hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
            string destination = Path.Combine(requestDirectory, artifactId + ".png");
            File.Move(actual[0], destination); // Owned source, generated destination, never overwrite.
            return new ImageReceipt { artifact_id = artifactId, request_id = requestId, path = destination, sha256 = digest,
                bytes = file.Length, width = width, height = height, view_id = view.Id.Value, source_view_id = sourceViewId,
                view_name = view.Name, view_is_temporary = temporary, orientation = orientation, captured_at = DateTime.UtcNow.ToString("o") };
        }

        private void ThrowIfCancelled(string requestId)
        {
            string file = Path.Combine(root, "queue", "cancel", requestId + ".json");
            if (!File.Exists(file)) return;
            try
            {
                FileInfo info = new FileInfo(file);
                if (info.Length < 1 || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException();
                var json = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 };
                var marker = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                if (marker == null || marker.Count != 3 || !marker.ContainsKey("schema_version") || !(marker["schema_version"] is int) || (int)marker["schema_version"] != 1 ||
                    RequiredText(marker, "request_id", 36) != requestId || RequiredText(marker, "target_session", 32) != hostSession) throw new InvalidOperationException();
            }
            catch { throw new VisualFailure("VISUAL_CANCEL_MARKER_INVALID", "The visual cancellation marker could not be verified."); }
            throw new VisualFailure("VISUAL_CANCELLED", "Visual capture was cancelled; owned view restoration still runs.");
        }

        private static void CopyPhase(View source, View target, BuiltInParameter parameter)
        {
            Parameter from = source.get_Parameter(parameter), to = target.get_Parameter(parameter);
            if (from != null && to != null && !to.IsReadOnly && from.StorageType == StorageType.ElementId && to.StorageType == StorageType.ElementId)
                to.Set(from.AsElementId());
        }
        private static BoundingBoxXYZ ElementBounds(IEnumerable<Element> elements)
        {
            XYZ min = null, max = null;
            foreach (Element element in elements)
            {
                BoundingBoxXYZ box = element.get_BoundingBox(null);
                if (box == null) throw new VisualFailure("VISUAL_TARGET_BOUNDS_MISSING", "A target has no model bounding box: " + element.Id.Value);
                foreach (XYZ point in Corners(box))
                {
                    if (!Finite(point.X) || !Finite(point.Y) || !Finite(point.Z)) throw new InvalidOperationException("Target bounds are not finite.");
                    min = min == null ? point : new XYZ(Math.Min(min.X, point.X), Math.Min(min.Y, point.Y), Math.Min(min.Z, point.Z));
                    max = max == null ? point : new XYZ(Math.Max(max.X, point.X), Math.Max(max.Y, point.Y), Math.Max(max.Z, point.Z));
                }
            }
            double diagonal = min.DistanceTo(max), margin = Math.Max(1.0, diagonal * 0.15);
            return new BoundingBoxXYZ { Min = min - new XYZ(margin, margin, margin), Max = max + new XYZ(margin, margin, margin) };
        }
        private static IEnumerable<XYZ> Corners(BoundingBoxXYZ box)
        {
            for (int x = 0; x < 2; x++) for (int y = 0; y < 2; y++) for (int z = 0; z < 2; z++)
                yield return box.Transform.OfPoint(new XYZ(x == 0 ? box.Min.X : box.Max.X, y == 0 ? box.Min.Y : box.Max.Y, z == 0 ? box.Min.Z : box.Max.Z));
        }
        private static void OrientAndFrame(View3D view, BoundingBoxXYZ bounds, string orientation)
        {
            XYZ forward = orientation == "front" ? new XYZ(0, -1, 0) : orientation == "side" ? new XYZ(-1, 0, 0) : new XYZ(-1, -1, -0.7).Normalize();
            XYZ up = (XYZ.BasisZ - forward.Multiply(XYZ.BasisZ.DotProduct(forward))).Normalize();
            XYZ center = (bounds.Min + bounds.Max).Multiply(0.5);
            double distance = Math.Max(bounds.Min.DistanceTo(bounds.Max) * 2, 10.0);
            view.SetOrientation(new ViewOrientation3D(center - forward.Multiply(distance), up, forward));
            view.SetSectionBox(bounds); view.IsSectionBoxActive = true;
        }
        private static void CropToBounds(View3D view, BoundingBoxXYZ bounds)
        {
            BoundingBoxXYZ crop = view.CropBox;
            if (crop == null) throw new InvalidOperationException("Inspection crop could not be read.");
            Transform inverse = crop.Transform.Inverse;
            XYZ min = null, max = null;
            foreach (XYZ corner in Corners(bounds))
            {
                XYZ point = inverse.OfPoint(corner);
                min = min == null ? point : new XYZ(Math.Min(min.X, point.X), Math.Min(min.Y, point.Y), Math.Min(min.Z, point.Z));
                max = max == null ? point : new XYZ(Math.Max(max.X, point.X), Math.Max(max.Y, point.Y), Math.Max(max.Z, point.Z));
            }
            crop.Min = min; crop.Max = max; view.CropBox = crop; view.CropBoxActive = true; view.CropBoxVisible = false;
        }
        private static View ViewByArgument(Document doc, Dictionary<string, object> args, string key, View fallback)
        {
            View view = args.ContainsKey(key) ? RequiredElement(doc, Integer(args[key], key, 1, 9007199254740991L)) as View : fallback;
            if (view == null || view.IsTemplate || !view.CanBePrinted) throw new VisualFailure("VISUAL_VIEW_UNSUPPORTED", "The requested view is not an exportable non-template view.");
            return view;
        }
        private static Element RequiredElement(Document doc, long id)
        {
            Element element = doc.GetElement(new ElementId(id));
            if (element == null || !element.IsValidObject || element is ElementType) throw new VisualFailure("VISUAL_ELEMENT_NOT_FOUND", "An inspection element is missing or is a type: " + id);
            return element;
        }
        private static string[] Orientations(Dictionary<string, object> args)
        {
            if (!args.ContainsKey("orientations")) return new[] { "isometric" };
            IList values = args["orientations"] as IList;
            if (values == null || values.Count < 1 || values.Count > 3) throw new InvalidOperationException("orientations must contain one to three named views.");
            string[] names = values.Cast<object>().Select(value => value as string).ToArray();
            if (names.Any(value => !new[] { "isometric", "front", "side" }.Contains(value, StringComparer.Ordinal)) || names.Distinct(StringComparer.Ordinal).Count() != names.Length)
                throw new InvalidOperationException("orientations must contain distinct isometric, front or side values.");
            return names;
        }
        private static long[] ElementIds(Dictionary<string, object> args, string key, int minimum, int maximum, bool required)
        {
            if (!args.ContainsKey(key)) { if (required) throw new InvalidOperationException(key + " is required."); return new long[0]; }
            IList values = args[key] as IList;
            if (values == null || values.Count < minimum || values.Count > maximum) throw new InvalidOperationException("Invalid " + key + " count.");
            long[] ids = values.Cast<object>().Select(value => Integer(value, key, 1, 9007199254740991L)).ToArray();
            if (ids.Distinct().Count() != ids.Length) throw new InvalidOperationException(key + " must contain distinct ids.");
            return ids;
        }
        private static int OptionalInteger(Dictionary<string, object> args, string key, int fallback, int minimum, int maximum)
        { return args.ContainsKey(key) ? (int)Integer(args[key], key, minimum, maximum) : fallback; }
        private static long Integer(object value, string key, long minimum, long maximum)
        {
            if (!(value is int || value is long || value is decimal || value is double)) throw new InvalidOperationException(key + " must be an integer.");
            decimal number;
            try { number = Convert.ToDecimal(value, CultureInfo.InvariantCulture); } catch { throw new InvalidOperationException(key + " must be a bounded integer."); }
            if (number != Decimal.Truncate(number) || number < minimum || number > maximum) throw new InvalidOperationException(key + " is outside its integer bounds.");
            return (long)number;
        }
        private static string RequiredText(Dictionary<string, object> args, string key, int maximum)
        {
            object value;
            if (!args.TryGetValue(key, out value) || !(value is string) || ((string)value).Length < 1 || ((string)value).Length > maximum) throw new InvalidOperationException("Invalid " + key + ".");
            return (string)value;
        }
        private static void Fields(Dictionary<string, object> args, params string[] fields)
        { if (args.Keys.Any(key => !fields.Contains(key, StringComparer.Ordinal))) throw new InvalidOperationException("Unknown visual operation argument."); }
        private static void OwnedDirectory(string directory)
        {
            Directory.CreateDirectory(directory);
            if ((VisualNativeStorage.AttributesRequired(directory) & 1024) != 0) throw new InvalidOperationException("Visual output directories must not be links or junctions.");
        }
        private sealed class StorageCoverage { internal int Entries, Images; internal long Bytes; }
        private void RequireStorageCapacity(int addedImages, long addedBytes)
        {
            string captureRoot = Path.Combine(root, "visual-captures");
            var coverage = new StorageCoverage();
            try
            {
                int rootAttributes = VisualNativeStorage.Attributes(captureRoot);
                if (rootAttributes != -1) { if ((rootAttributes & 16) == 0) throw new InvalidOperationException("Visual capture root is not a directory."); ScanStorage(captureRoot, 0, coverage); }
            }
            catch (VisualFailure) { throw; }
            catch { throw new VisualFailure("VISUAL_STORAGE_UNVERIFIED", "Visual evidence capacity could not be verified; no capture was admitted and existing evidence was retained."); }
            if (coverage.Images > StorageImages - addedImages || coverage.Bytes > StorageBytes - addedBytes)
                throw new VisualFailure("VISUAL_STORAGE_LIMIT", "Visual evidence reached its 512 PNG / 128 MiB capacity; no capture was admitted and existing evidence was retained.");
        }
        private static void ScanStorage(string directory, int depth, StorageCoverage coverage)
        {
            if ((VisualNativeStorage.AttributesRequired(directory) & 1024) != 0)
                throw new VisualFailure("VISUAL_STORAGE_UNVERIFIED", "Visual evidence contains a linked directory; capacity was not adopted.");
            foreach (VisualNativeStorage.Entry entry in VisualNativeStorage.Enumerate(directory))
            {
                if (++coverage.Entries > StorageEntries)
                    throw new VisualFailure("VISUAL_STORAGE_LIMIT", "Visual evidence exceeded its 4096-entry capacity scan; existing evidence was retained.");
                FileAttributes attributes = (FileAttributes)entry.Attributes;
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new VisualFailure("VISUAL_STORAGE_UNVERIFIED", "Visual evidence contains a link; capacity was not adopted.");
                string name = entry.Name;
                bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                if (isDirectory)
                {
                    bool known = depth == 0 ? name.Length == 32 && name.All(character => character >= '0' && character <= '9' || character >= 'a' && character <= 'f') :
                        depth == 1 ? IsGuid(name) : depth == 2 && ((name.StartsWith("staging-", StringComparison.Ordinal) && IsGuid(name.Substring(8))) || (name.StartsWith("s", StringComparison.Ordinal) && IsGuidN(name.Substring(1))));
                    if (!known) throw new VisualFailure("VISUAL_STORAGE_UNVERIFIED", "Visual evidence contains an unknown directory; capacity was not adopted.");
                    ScanStorage(directory + "\\" + name, depth + 1, coverage);
                }
                else
                {
                    bool canonical = depth == 2 && name.EndsWith(".png", StringComparison.OrdinalIgnoreCase) && IsGuid(name.Substring(0, name.Length - 4));
                    string parentName = directory.Substring(directory.LastIndexOf('\\') + 1);
                    bool staging = depth == 3 && name.EndsWith(".png", StringComparison.OrdinalIgnoreCase) &&
                        ((parentName.StartsWith("staging-", StringComparison.Ordinal) && name.StartsWith("render", StringComparison.Ordinal)) ||
                         (parentName.StartsWith("s", StringComparison.Ordinal) && IsGuidN(parentName.Substring(1)) && name.StartsWith("r", StringComparison.Ordinal)));
                    if (!canonical && !staging) throw new VisualFailure("VISUAL_STORAGE_UNVERIFIED", "Visual evidence contains an unknown file; capacity was not adopted.");
                    long bytes = entry.Length;
                    if (++coverage.Images > StorageImages || bytes > StorageBytes || coverage.Bytes > StorageBytes - bytes)
                        throw new VisualFailure("VISUAL_STORAGE_LIMIT", "Visual evidence exceeded its 512 PNG / 128 MiB capacity; existing evidence was retained.");
                    coverage.Bytes += bytes;
                }
            }
        }
        private static bool IsGuidN(string value) { Guid id; return Guid.TryParseExact(value, "N", out id); }
        private static bool IsGuid(string value) { Guid id; return Guid.TryParseExact(value, "D", out id); }
        private static bool Finite(double number) { return !Double.IsNaN(number) && !Double.IsInfinity(number) && Math.Abs(number) <= 1e9; }
    }
}

// Controlled Revit API peer for executing the real VisualInspection owner.
// This proves lifecycle/contract behavior, not Autodesk rendering or API behavior.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitLocalCodex;

namespace BuildX.FamilyRevit
{
    public sealed class RevitProjectDocumentSource
    {
        public RevitProjectDocumentSource(int thread) { }
        public bool? SameOpenDocument(Document a, Document b) { return a != null && a.Valid && Object.ReferenceEquals(a, b); }
    }
}
namespace Autodesk.Revit.UI
{
    public sealed class UIApplication { public UIDocument ActiveUIDocument; }
    public sealed class UIDocument { public Document Document; }
}
namespace Autodesk.Revit.DB
{
    public enum TransactionStatus { Uninitialized, Started, Committed, RolledBack }
    public enum ViewFamily { ThreeDimensional }
    public enum ViewDetailLevel { Fine }
    public enum DisplayStyle { Shading }
    public enum BuiltInParameter { VIEW_PHASE, VIEW_PHASE_FILTER }
    public enum StorageType { ElementId }
    public enum ExportRange { SetOfViews }
    public enum ZoomFitType { FitToPage }
    public enum FitDirectionType { Horizontal, Vertical }
    public enum ImageResolution { DPI_150 }
    public enum ImageFileType { PNG }
    public sealed class ElementId { public long Value; public ElementId(long value) { Value = value; } }
    public class Element
    {
        public ElementId Id; public string UniqueId, Name; public bool IsValidObject = true;
        public BoundingBoxXYZ Bounds;
        public BoundingBoxXYZ get_BoundingBox(View view) { return Bounds; }
    }
    public class ElementType : Element { }
    public class View : Element
    {
        public bool IsTemplate, CanBePrinted = true, CropBoxActive, CropBoxVisible;
        public BoundingBoxUV Outline = new BoundingBoxUV { Min = new UV(0, 0), Max = new UV(2, 1) };
        public BoundingBoxXYZ CropBox = new BoundingBoxXYZ { Min = new XYZ(-1, -1, -1), Max = new XYZ(1, 1, 1) };
        public Parameter get_Parameter(BuiltInParameter parameter) { return null; }
    }
    public sealed class Parameter { public bool IsReadOnly; public StorageType StorageType; public ElementId AsElementId() { return new ElementId(1); } public void Set(ElementId id) { } }
    public sealed class ViewFamilyType : ElementType { public ViewFamily ViewFamily; }
    public sealed class View3D : View
    {
        public ViewDetailLevel DetailLevel; public DisplayStyle DisplayStyle; public bool IsSectionBoxActive;
        public BoundingBoxXYZ Section; public ViewOrientation3D Orientation; public IList<ElementId> Isolated;
        private Document document;
        public static View3D CreateIsometric(Document document, ElementId type)
        {
            var view = new View3D { document = document, Id = new ElementId(++document.NextId), UniqueId = Guid.NewGuid().ToString("D"), Name = "new" };
            document.Elements.Add(view); document.CreatedViews.Add(view); return view;
        }
        public void SetOrientation(ViewOrientation3D orientation) { Orientation = orientation; }
        public void SetSectionBox(BoundingBoxXYZ bounds) { Section = bounds; }
        public void IsolateElementsTemporary(IList<ElementId> ids) { Isolated = ids; }
    }
    public sealed class ViewOrientation3D
    {
        public XYZ Eye, Up, Forward;
        public ViewOrientation3D(XYZ eye, XYZ up, XYZ forward) { Eye = eye; Up = up; Forward = forward; }
    }
    public sealed class XYZ
    {
        public readonly double X, Y, Z;
        public XYZ(double x, double y, double z) { X = x; Y = y; Z = z; }
        public static XYZ BasisZ { get { return new XYZ(0, 0, 1); } }
        public static XYZ operator +(XYZ a, XYZ b) { return new XYZ(a.X + b.X, a.Y + b.Y, a.Z + b.Z); }
        public static XYZ operator -(XYZ a, XYZ b) { return new XYZ(a.X - b.X, a.Y - b.Y, a.Z - b.Z); }
        public XYZ Multiply(double scale) { return new XYZ(X * scale, Y * scale, Z * scale); }
        public double DotProduct(XYZ b) { return X * b.X + Y * b.Y + Z * b.Z; }
        public double DistanceTo(XYZ b) { XYZ v = this - b; return Math.Sqrt(v.DotProduct(v)); }
        public XYZ Normalize() { return Multiply(1 / Math.Sqrt(DotProduct(this))); }
    }
    public sealed class Transform
    {
        public double X, Y, Z;
        public XYZ OfPoint(XYZ p) { return p + new XYZ(X, Y, Z); }
        public Transform Inverse { get { return new Transform { X = -X, Y = -Y, Z = -Z }; } }
    }
    public sealed class BoundingBoxXYZ { public XYZ Min, Max; public Transform Transform = new Transform(); }
    public sealed class UV { public double U, V; public UV(double u, double v) { U = u; V = v; } }
    public sealed class BoundingBoxUV { public UV Min, Max; }
    public sealed class ImageExportOptions
    {
        public ExportRange ExportRange; public ZoomFitType ZoomType; public int PixelSize; public FitDirectionType FitDirection;
        public ImageResolution ImageResolution; public ImageFileType HLRandWFViewsFileType, ShadowViewsFileType; public string FilePath;
        public IList<ElementId> Views;
        public void SetViewsAndSheets(IList<ElementId> views) { Views = views; }
    }
    public sealed class FilteredElementCollector : IEnumerable<Element>, IDisposable
    {
        private readonly Document document;
        public FilteredElementCollector(Document document) { this.document = document; }
        public FilteredElementCollector OfClass(Type type) { return this; }
        public IEnumerator<Element> GetEnumerator() { return document.Elements.OfType<ViewFamilyType>().Cast<Element>().GetEnumerator(); }
        IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
        public void Dispose() { }
    }
    public sealed class Document
    {
        public string PathName = @"D:\fixture\sample.rvt", Title = "sample.rvt";
        public bool IsReadOnly, IsModifiable, Valid = true, FailExport, FailGroupRollback, FailGroupDispose;
        public long NextId = 1000; public int Exports; public FitDirectionType LastFit;
        public View ActiveView;
        public readonly List<Element> Elements = new List<Element>();
        public readonly List<View3D> CreatedViews = new List<View3D>();
        public Action<int> OnExport;
        public Element GetElement(ElementId id) { return Elements.FirstOrDefault(element => element.Id.Value == id.Value); }
        public Element GetElement(string uid) { return Elements.FirstOrDefault(element => element.UniqueId == uid); }
        public void Regenerate() { }
        public void Delete(ICollection<ElementId> ids) { Elements.RemoveAll(element => ids.Any(id => element.Id.Value == id.Value)); }
        public void ExportImage(ImageExportOptions options)
        {
            if (IsModifiable) throw new Exception("Export with an unfinished transaction");
            Exports++; LastFit = options.FitDirection; if (FailExport) throw new Exception("controlled export failure");
            using (var bitmap = new Bitmap(80, 40)) bitmap.Save(options.FilePath + "-actual.png", System.Drawing.Imaging.ImageFormat.Png);
            if (OnExport != null) OnExport(Exports);
        }
    }
    public sealed class Transaction : IDisposable
    {
        private readonly Document document; private List<Element> before; private TransactionStatus status;
        public Transaction(Document document, string name) { this.document = document; }
        public TransactionStatus Start() { before = document.Elements.ToList(); document.IsModifiable = true; return status = TransactionStatus.Started; }
        public TransactionStatus GetStatus() { return status; }
        public TransactionStatus Commit() { document.IsModifiable = false; return status = TransactionStatus.Committed; }
        public TransactionStatus RollBack() { document.Elements.Clear(); document.Elements.AddRange(before); document.IsModifiable = false; return status = TransactionStatus.RolledBack; }
        public void Dispose() { if (status == TransactionStatus.Started) RollBack(); }
    }
    public sealed class TransactionGroup : IDisposable
    {
        private readonly Document document; private List<Element> before; private TransactionStatus status;
        public TransactionGroup(Document document, string name) { this.document = document; }
        public TransactionStatus Start() { before = document.Elements.ToList(); return status = TransactionStatus.Started; }
        public TransactionStatus GetStatus() { return status; }
        public TransactionStatus RollBack()
        {
            if (document.FailGroupRollback) throw new Exception("controlled rollback failure");
            document.Elements.Clear(); document.Elements.AddRange(before); return status = TransactionStatus.RolledBack;
        }
        public void Dispose()
        {
            if (document.FailGroupDispose) throw new Exception("controlled disposal failure");
            if (status == TransactionStatus.Started) RollBack();
        }
    }
}

internal static class NativeVisualFixture
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static int assertions;
    private static void Assert(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    private static Dictionary<string, object> ObjectValue(object value) { return Json.Deserialize<Dictionary<string, object>>(Json.Serialize(value)); }
    private static Dictionary<string, object> Child(Dictionary<string, object> value, string key) { return (Dictionary<string, object>)value[key]; }
    private static object[] ArrayValue(Dictionary<string, object> value, string key) { return ((ArrayList)value[key]).Cast<object>().ToArray(); }
    private static Document Document()
    {
        var doc = new Document();
        var view = new View { Id = new ElementId(12), UniqueId = "original-view", Name = "Original" };
        doc.ActiveView = view; doc.Elements.Add(view);
        doc.Elements.Add(new ViewFamilyType { Id = new ElementId(13), UniqueId = "view-type", ViewFamily = ViewFamily.ThreeDimensional });
        doc.Elements.Add(new Element { Id = new ElementId(42), UniqueId = "target", Name = "wall",
            Bounds = new BoundingBoxXYZ { Min = new XYZ(0, 0, 0), Max = new XYZ(10, 2, 8), Transform = new Transform { X = 100, Y = 200 } } });
        doc.Elements.Add(new Element { Id = new ElementId(84), UniqueId = "context", Name = "floor", Bounds = new BoundingBoxXYZ { Min = new XYZ(0, 0, 0), Max = new XYZ(1000, 1000, 1) } });
        return doc;
    }
    private static UIApplication App(Document document) { return new UIApplication { ActiveUIDocument = new UIDocument { Document = document } }; }
    private static Dictionary<string, object> Args(Document doc, params string[] orientations)
    {
        return new Dictionary<string, object> { { "expected_document", doc.PathName }, { "element_ids", new object[] { 42 } },
            { "context_element_ids", new object[] { 84 } }, { "orientations", orientations.Length == 0 ? new[] { "isometric" } : orientations } };
    }
    private static Dictionary<string, object> Execute(VisualInspection owner, UIApplication app, string operation, Dictionary<string, object> args)
    { return ObjectValue(owner.Execute(app, operation, args, Guid.NewGuid().ToString("D"))); }
    public static int Main(string[] argv)
    {
        string root = argv[0], session = new string('a', 32); Directory.CreateDirectory(root);
        var doc = Document(); var app = App(doc); var owner = new VisualInspection(session, root);
        var result = Execute(owner, app, "inspect_elements", Args(doc, "isometric", "front", "side"));
        Assert((bool)result["success"], "three-view capture succeeds");
        Assert((string)Child(result, "restoration")["status"] == "restored", "group rollback is verified");
        Assert(ArrayValue(result, "images").Length == 3 && doc.Exports == 3, "all requested images retained");
        Assert(doc.Elements.Count == 4 && Object.ReferenceEquals(doc.ActiveView, doc.Elements[0]), "original view and model preserved");
        Assert(doc.CreatedViews.All(view => view.Isolated.Count == 2), "target and explicit context isolated together");
        Assert(doc.CreatedViews.All(view => view.Section.Min.X > 90 && view.Section.Min.Y > 190), "transformed target bounds frame target, not enormous context");
        Assert(!owner.CleanupPending, "no cleanup lease after success");
        foreach (Dictionary<string, object> image in ArrayValue(result, "images"))
        {
            string file = (string)image["path"];
            Assert(File.Exists(file) && Path.GetFileName(file) == (string)image["artifact_id"] + ".png", "verified canonical image exists");
            Assert((int)image["width"] == 80 && (int)image["height"] == 40, "actual PNG dimensions returned");
        }
        doc.FailExport = true;
        result = Execute(owner, app, "inspect_elements", Args(doc));
        Assert(!(bool)result["success"] && (string)Child(result, "restoration")["status"] == "restored", "export failure still restores");
        Assert(doc.Elements.Count == 4 && !owner.CleanupPending, "failed export leaves no inspection view");
        doc.FailExport = false;
        string cancelId = Guid.NewGuid().ToString("D");
        doc.OnExport = count => { string directory = Path.Combine(root, "queue", "cancel"); Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, cancelId + ".json"), Json.Serialize(new { schema_version = 1, request_id = cancelId, target_session = session })); };
        result = ObjectValue(owner.Execute(app, "inspect_elements", Args(doc, "isometric", "front"), cancelId));
        Assert((string)result["code"] == "VISUAL_CANCELLED" && ArrayValue(result, "images").Length == 1, "cancellation keeps exact first frame without second export");
        Assert((string)Child(result, "restoration")["status"] == "restored" && !owner.CleanupPending, "cancellation cannot suppress restoration");
        doc.OnExport = null; doc.FailGroupRollback = true; doc.FailGroupDispose = true;
        result = Execute(owner, app, "inspect_elements", Args(doc));
        Assert(owner.CleanupPending && (string)Child(result, "restoration")["status"] == "pending", "failed final cleanup retains ownership");
        string handle = (string)Child(result, "restoration")["session_handle"];
        int exportsBefore = doc.Exports;
        result = Execute(owner, app, "capture_view", new Dictionary<string, object> { { "expected_document", doc.PathName } });
        Assert(doc.Exports == exportsBefore && (string)result["code"] == "VISUAL_RESTORE_REQUIRED", "new captures blocked until restoration");
        bool foreignRejected = false;
        try { Execute(owner, App(Document()), "restore_visual_session", new Dictionary<string, object> { { "expected_document", doc.PathName }, { "session_handle", handle } }); }
        catch (InvalidOperationException) { foreignRejected = true; }
        Assert(foreignRejected && owner.CleanupPending, "same filename in another document does not authorize cleanup");
        doc.FailGroupRollback = false; doc.FailGroupDispose = false;
        result = Execute(owner, app, "restore_visual_session", new Dictionary<string, object> { { "expected_document", doc.PathName }, { "session_handle", handle } });
        Assert((bool)result["success"] && !owner.CleanupPending && doc.Elements.Count == 4, "named restoration retries original owned cleanup");
        result = Execute(owner, app, "capture_view", new Dictionary<string, object> { { "expected_document", doc.PathName }, { "view_id", 12 } });
        Assert((bool)result["success"] && (string)Child(result, "restoration")["status"] == "unchanged", "direct capture leaves view state unchanged");
        string originalName = doc.ActiveView.Name;
        doc.ActiveView.Name = new string('x', 180);
        exportsBefore = doc.Exports;
        result = Execute(owner, app, "capture_view", new Dictionary<string, object> { { "expected_document", doc.PathName } });
        Assert((string)result["code"] == "VISUAL_EXPORT_PATH_TOO_LONG" && doc.Exports == exportsBefore && !owner.CleanupPending,
            "overlong export path rejects before entering the Revit API");
        Assert(doc.ActiveView.Name == new string('x', 180), "preflight preserves the source view name");
        doc.ActiveView.Name = originalName;
        doc.ActiveView.Outline.Max = new UV(1, 3);
        result = Execute(owner, app, "capture_view", new Dictionary<string, object> { { "expected_document", doc.PathName } });
        Assert((bool)result["success"] && doc.LastFit == FitDirectionType.Vertical, "portrait view fits requested long edge");
        var overlap = Args(doc); overlap["context_element_ids"] = new object[] { 42, 84 };
        result = Execute(owner, app, "inspect_elements", overlap);
        Assert((bool)result["success"] && ArrayValue(result, "context_ids").Length == 2 && doc.CreatedViews.Last().Isolated.Count == 2,
            "caller context coverage preserved while actual isolation de-duplicates targets");
        string invalidCancelId = Guid.NewGuid().ToString("D");
        File.WriteAllText(Path.Combine(root, "queue", "cancel", invalidCancelId + ".json"), Json.Serialize(new { schema_version = 1, request_id = invalidCancelId, target_session = new string('b', 32) }));
        result = ObjectValue(owner.Execute(app, "inspect_elements", Args(doc), invalidCancelId));
        Assert((string)result["code"] == "VISUAL_CANCEL_MARKER_INVALID" && !owner.CleanupPending, "foreign cancellation marker cannot authorize a cancellation");
        var invalid = Args(doc); invalid["element_ids"] = new object[] { 99999 };
        result = Execute(owner, app, "inspect_elements", invalid);
        Assert(!(bool)result["success"] && !owner.CleanupPending && doc.Elements.Count == 4, "missing target fails before view creation");
        string fullRoot = Path.Combine(root, "full-capacity"), fullRequest = Path.Combine(fullRoot, "visual-captures", session, Guid.NewGuid().ToString("D"));
        Directory.CreateDirectory(fullRequest);
        for (int index = 0; index < 512; index++) File.WriteAllBytes(Path.Combine(fullRequest, Guid.NewGuid().ToString("D") + ".png"), new byte[0]);
        var fullDoc = Document(); var fullOwner = new VisualInspection(session, fullRoot);
        result = Execute(fullOwner, App(fullDoc), "inspect_elements", Args(fullDoc));
        Assert((string)result["code"] == "VISUAL_STORAGE_LIMIT" && fullDoc.Exports == 0 && fullDoc.CreatedViews.Count == 0 && fullDoc.Elements.Count == 4,
            "512 existing images refuse the complete inspection before model changes");
        Assert(Directory.GetFiles(fullRequest).Length == 512 && !fullOwner.CleanupPending, "capacity refusal preserves every original file and needs no restoration");
        string unknownRoot = Path.Combine(root, "unknown-capacity"), unknownCapture = Path.Combine(unknownRoot, "visual-captures");
        Directory.CreateDirectory(unknownCapture); File.WriteAllText(Path.Combine(unknownCapture, "unknown.txt"), "retained original");
        var unknownDoc = Document();
        result = Execute(new VisualInspection(session, unknownRoot), App(unknownDoc), "capture_view", new Dictionary<string, object> { { "expected_document", unknownDoc.PathName } });
        Assert((string)result["code"] == "VISUAL_STORAGE_UNVERIFIED" && unknownDoc.Exports == 0 && unknownDoc.Elements.Count == 4,
            "unknown capacity file fails closed without exporting or changing the source view");
        Assert(File.ReadAllText(Path.Combine(unknownCapture, "unknown.txt")) == "retained original", "unknown files are not removed or overwritten");
        string byteRoot = Path.Combine(root, "byte-capacity"), byteRequest = Path.Combine(byteRoot, "visual-captures", session, Guid.NewGuid().ToString("D"));
        Directory.CreateDirectory(byteRequest);
        using (var file = File.Create(Path.Combine(byteRequest, Guid.NewGuid().ToString("D") + ".png"))) file.SetLength(127L * 1024 * 1024);
        var byteDoc = Document();
        result = Execute(new VisualInspection(session, byteRoot), App(byteDoc), "capture_view", new Dictionary<string, object> { { "expected_document", byteDoc.PathName } });
        Assert((string)result["code"] == "VISUAL_STORAGE_LIMIT" && byteDoc.Exports == 0 && byteDoc.Elements.Count == 4,
            "actual existing bytes reserve the next image before any export");
        Console.WriteLine(Json.Serialize(new { assertions, passed = true, scope = "Real VisualInspection owner with controlled API peer; not a live Revit/rendering test" }));
        return 0;
    }
}

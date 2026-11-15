using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using BuildX.FamilyCore;

namespace BuildX.FamilyRevit
{
    internal sealed class PumpFamilyArtifact
    {
        internal const string Operation = "create_pump_family_artifact";
        internal const string OpenOperation = "open_pump_family_artifact";
        private const string TemplateId = "metric-mechanical-equipment";
        private const string TypeName = "BuildX-Standard";
        private const double ToleranceMm = .1;
        private const long MaxArtifactBytes = 64L * 1024 * 1024;
        private const FileAttributes UnsafeFile = FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device;
        private readonly string artifacts;
        private readonly RevitConfiguredTemplateSource templates;
        private UIApplication currentApp;
        private Document ownedDocument;

        private sealed class PumpSpec
        {
            internal string Name;
            internal double Width, Depth, Height, Inlet, Outlet;
            internal PipeSystemType System;
            internal MEPSystemClassification Classification;

            internal static PumpSpec Parse(Dictionary<string, object> args)
            {
                if (args == null || args.Count != 7 || !args.ContainsKey("file_name") || !args.ContainsKey("system"))
                    throw new InvalidOperationException("A pump needs a file name, dimensions, both diameters and a piping system.");
                string name = args["file_name"] as string;
                if (!ValidName(name))
                    throw new InvalidOperationException("Invalid pump family file name.");
                var spec = new PumpSpec {
                    Name = name, Width = Number(args, "width_mm", 150, 6000), Depth = Number(args, "depth_mm", 150, 6000),
                    Height = Number(args, "height_mm", 150, 6000), Inlet = Number(args, "inlet_diameter_mm", 10, 1200),
                    Outlet = Number(args, "outlet_diameter_mm", 10, 1200)
                };
                if (Math.Max(spec.Inlet, spec.Outlet) > .30 * Math.Min(spec.Width, Math.Min(spec.Depth, spec.Height)))
                    throw new InvalidOperationException("Pump port diameters must not exceed 30% of the smallest pump dimension.");
                switch (args["system"] as string)
                {
                    case "hydronic_supply":
                        spec.System = PipeSystemType.SupplyHydronic; spec.Classification = MEPSystemClassification.SupplyHydronic; break;
                    case "hydronic_return":
                        spec.System = PipeSystemType.ReturnHydronic; spec.Classification = MEPSystemClassification.ReturnHydronic; break;
                    case "domestic_cold_water":
                        spec.System = PipeSystemType.DomesticColdWater; spec.Classification = MEPSystemClassification.DomesticColdWater; break;
                    default: throw new InvalidOperationException("Unsupported pump piping system.");
                }
                return spec;
            }

            private static double Number(Dictionary<string, object> args, string key, double minimum, double maximum)
            {
                object raw;
                if (!args.TryGetValue(key, out raw) || !(raw is int || raw is long || raw is decimal || raw is double))
                    throw new InvalidOperationException("A numeric pump dimension is required.");
                double value = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                if (Double.IsNaN(value) || value < minimum || value > maximum)
                    throw new InvalidOperationException("A pump dimension is outside the supported range.");
                return value;
            }
        }

        private sealed class PumpValidationException : InvalidOperationException
        {
            internal readonly string Reason;
            internal PumpValidationException(string reason) : base(reason) { Reason = reason; }
        }

        private sealed class PortGeometryEvidence
        {
            private const int MaxCount = 10000;
            internal readonly string Port;
            internal readonly XYZ Center, Outward;
            internal readonly double Radius, Depth;
            internal XYZ SketchNormal;
            internal double? StartOffset, EndOffset;
            internal int Solids, Instances, Planar, Referenced, Aligned, Coplanar, Circular, Matched;
            private readonly List<object> candidates = new List<object>();

            internal PortGeometryEvidence(string port, XYZ center, XYZ outward, double radius, double depth)
            { Port = port; Center = center; Outward = outward; Radius = radius; Depth = depth; }

            internal void AddCandidate(XYZ normal, double axisDelta, double? radius, bool hasReference, string rejectedBy)
            {
                if (candidates.Count == 8 || !(Math.Abs(axisDelta) <= Ft(20000))) return;
                var row = new Dictionary<string, object> {
                    { "normal", Vector(normal) }, { "axisDeltaMm", Mm(axisDelta) },
                    { "hasReference", hasReference }, { "rejectedBy", rejectedBy }
                };
                if (radius.HasValue && radius.Value >= 0 && radius.Value <= Ft(20000)) row.Add("radiusMm", Mm(radius.Value));
                candidates.Add(row);
            }

            internal object Dto()
            {
                var dto = new Dictionary<string, object> {
                    { "port", Port }, { "expectedCenterMm", new[] { Mm(Center.X), Mm(Center.Y), Mm(Center.Z) } },
                    { "expectedNormal", Vector(Outward) }, { "expectedRadiusMm", Mm(Radius) },
                    { "counts", new {
                        solids = Math.Min(Solids, MaxCount), instances = Math.Min(Instances, MaxCount), planar = Math.Min(Planar, MaxCount),
                        referenced = Math.Min(Referenced, MaxCount), aligned = Math.Min(Aligned, MaxCount), coplanar = Math.Min(Coplanar, MaxCount),
                        circular = Math.Min(Circular, MaxCount), matched = Math.Min(Matched, MaxCount) } },
                    { "candidates", candidates.ToArray() }
                };
                if (SketchNormal != null) dto.Add("sketchNormal", Vector(SketchNormal));
                if (StartOffset.HasValue) dto.Add("startOffsetMm", Mm(StartOffset.Value));
                if (EndOffset.HasValue) dto.Add("endOffsetMm", Mm(EndOffset.Value));
                return dto;
            }

            private static double[] Vector(XYZ v) { return new[] { v.X, v.Y, v.Z }; }
        }

        private sealed class LocatedSolid
        {
            internal readonly Solid Shape;
            internal readonly Transform ToFamily;

            internal LocatedSolid(Solid solid, Transform transform)
            { Shape = solid; ToFamily = transform; }
        }

        private sealed class PumpDiagnostics : IFailuresPreprocessor
        {
            internal string Stage = "prepare";
            internal PortGeometryEvidence Geometry;
            private readonly HashSet<string> failureIds = new HashSet<string>(StringComparer.Ordinal);

            internal object Failure(string code, string outcome, string message, string reason = null, Exception error = null,
                bool saveAttempted = false, bool cleanupComplete = true)
            {
                var validation = error as PumpValidationException;
                string exceptionType = error == null ? "None" : (error.GetType().FullName ?? "Unknown").Replace('+', '.');
                if (exceptionType == null || exceptionType.Length > 128 ||
                    !Regex.IsMatch(exceptionType, @"\A[A-Za-z_][A-Za-z0-9_.]*\z"))
                    exceptionType = "Unknown";
                var diagnostic = new Dictionary<string, object> {
                    { "stage", Stage }, { "reason", reason ?? (validation == null ? "native_api_error" : validation.Reason) },
                    { "exceptionType", exceptionType }, { "saveAttempted", saveAttempted }, { "cleanupComplete", cleanupComplete },
                    { "failureIds", failureIds.OrderBy(id => id, StringComparer.Ordinal).ToArray() }
                };
                if (Geometry != null) diagnostic.Add("geometry", Geometry.Dto());
                return new { success = false, code, outcome, message, diagnostic };
            }

            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                bool rollback = false;
                foreach (FailureMessageAccessor item in accessor.GetFailureMessages())
                {
                    FailureSeverity severity = item.GetSeverity();
                    if (severity == FailureSeverity.Warning) accessor.DeleteWarning(item);
                    else if (severity >= FailureSeverity.Error)
                    {
                        rollback = true;
                        if (failureIds.Count < 8) failureIds.Add(item.GetFailureDefinitionId().Guid.ToString("D"));
                    }
                }
                return rollback ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }

        internal PumpFamilyArtifact(string root)
        {
            artifacts = Path.GetFullPath(Path.Combine(root, "family-artifacts"));
            templates = new RevitConfiguredTemplateSource(
                () => currentApp == null ? null : currentApp.Application.FamilyTemplatePath, allowEnglishMechanicalTemplate: true);
        }

        internal static bool IsOperation(string operation)
        { return operation == Operation || operation == OpenOperation; }

        internal static void ConsumeApproval(string queue, string session, string id, byte[] request, JavaScriptSerializer json)
        {
            Guid parsed;
            if (!Guid.TryParseExact(id, "D", out parsed)) throw new InvalidOperationException("Invalid pump request identity.");
            string directory = Path.Combine(queue, "pump-approvals");
            RequirePlainDirectoryChain(directory);
            string permit = Path.Combine(directory, id + ".json");
            RequirePlainFile(permit);
            byte[] bytes;
            using (var stream = new FileStream(permit, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length == 0 || stream.Length > 1024) throw new InvalidOperationException("Invalid pump approval length.");
                bytes = new byte[(int)stream.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int count = stream.Read(bytes, offset, bytes.Length - offset);
                    if (count == 0) throw new InvalidOperationException("Pump approval changed while reading.");
                    offset += count;
                }
                if (stream.ReadByte() != -1) throw new InvalidOperationException("Pump approval changed while reading.");
            }
            var proof = json.Deserialize<Dictionary<string, object>>(new System.Text.UTF8Encoding(false, true).GetString(bytes));
            object version, requestId, target, digest;
            if (proof == null || proof.Count != 4 || !proof.TryGetValue("schema_version", out version) || !(version is int) || (int)version != 1 ||
                !proof.TryGetValue("request_id", out requestId) || (requestId as string) != id ||
                !proof.TryGetValue("target_session", out target) || (target as string) != session ||
                !proof.TryGetValue("request_sha256", out digest) || (digest as string) != Sha256(request))
                throw new InvalidOperationException("Pump approval does not match the approved request.");
            RequirePlainDirectoryChain(directory);
            RequirePlainFile(permit);
            File.Move(permit, Path.Combine(directory, id + ".used"));
        }

        internal object Create(UIApplication app, Dictionary<string, object> args, string id, DateTime expires, Func<bool> mayContinue)
        {
            var diagnostics = new PumpDiagnostics();
            PumpSpec spec;
            Guid request;
            try
            {
                spec = PumpSpec.Parse(args);
                if (!Guid.TryParseExact(id, "D", out request)) throw new InvalidOperationException("Invalid pump request identity.");
            }
            catch (InvalidOperationException error)
            { return diagnostics.Failure("PUMP_INPUT_INVALID", "not_started", "Invalid pump family specification.", "invalid_input", error); }

            currentApp = app;
            bool saveAttempted = false;
            string name = spec.Name + "-" + request.ToString("N") + ".rfa";
            string output = Path.Combine(artifacts, name);
            try
            {
                if (!CloseOwned())
                {
                    diagnostics.Stage = "cleanup";
                    return diagnostics.Failure("PUMP_CLEANUP_PENDING", "not_started",
                        "A previous family document still needs cleanup.", "owned_document_close_failed", cleanupComplete: false);
                }
                RequireContinue(expires, mayContinue);
                RequirePlainDirectoryChain(Path.GetDirectoryName(artifacts));
                Directory.CreateDirectory(artifacts);
                RequirePlainDirectoryChain(artifacts);
                if (Exists(output))
                    return diagnostics.Failure("PUMP_OUTPUT_EXISTS", "unknown",
                        "This request already has an output. Check its original receipt.", "output_exists");
                diagnostics.Stage = "template";
                var template = templates.Inspect(TemplateId);
                if (template.State != FamilyTemplateState.BytesVerified ||
                    String.IsNullOrEmpty(template.SourcePath) || String.IsNullOrEmpty(template.Sha256))
                    return diagnostics.Failure("PUMP_TEMPLATE_UNAVAILABLE", "not_started",
                        "The configured Revit directory needs a metric Mechanical Equipment family template.", "template_unavailable");

                diagnostics.Stage = "new_document";
                List<Document> existing = OpenDocuments(app);
                Document family = app.Application.NewFamilyDocument(template.SourcePath);
                ClaimNewDocument(family, existing);
                diagnostics.Stage = "transaction_start";
                using (var transaction = new Transaction(family, "BuildX pump family"))
                {
                    if (transaction.Start() != TransactionStatus.Started)
                        throw new PumpValidationException("transaction_start_rejected");
                    var settings = transaction.GetFailureHandlingOptions();
                    settings.SetFailuresPreprocessor(diagnostics);
                    settings.SetClearAfterRollback(true);
                    transaction.SetFailureHandlingOptions(settings);
                    Build(family, spec, diagnostics);
                    diagnostics.Stage = "commit";
                    RequireContinue(expires, mayContinue);
                    if (transaction.Commit() != TransactionStatus.Committed)
                        throw new PumpValidationException("transaction_commit_rejected");
                }

                diagnostics.Stage = "verify_before_save";
                Inspect(family, spec);
                diagnostics.Stage = "save";
                RequireContinue(expires, mayContinue);
                RequirePlainDirectoryChain(artifacts);
                if (Exists(output))
                    return diagnostics.Failure("PUMP_OUTPUT_EXISTS", "unknown",
                        "This request already has an output. Check its original receipt.", "output_exists", cleanupComplete: CloseOwned());
                saveAttempted = true;
                using (var options = new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 1 })
                    family.SaveAs(output, options);
                if (!CloseOwned()) throw new PumpValidationException("owned_document_close_failed");
                long bytes;
                string sha = VerifyFile(output, out bytes);

                diagnostics.Stage = "reopen";
                existing = OpenDocuments(app);
                Document reopened = app.Application.OpenDocumentFile(output);
                ClaimNewDocument(reopened, existing);
                if (!MatchesPath(reopened, output)) throw new PumpValidationException("reopened_path_mismatch");
                diagnostics.Stage = "verify_reopened";
                object[] connectors = Inspect(reopened, spec);
                if (!CloseOwned()) throw new PumpValidationException("owned_document_close_failed");
                long afterBytes;
                if (VerifyFile(output, out afterBytes) != sha || bytes != afterBytes)
                    throw new PumpValidationException("saved_file_changed");
                return new { success = true, file_name = name, sha256 = sha, bytes, reopened = true, family_category = "MechanicalEquipment", type_name = TypeName,
                    width_mm = spec.Width, depth_mm = spec.Depth, height_mm = spec.Height, connectors };
            }
            catch (Exception error)
            {
                bool closed = CloseOwned();
                string code = saveAttempted ? "PUMP_ARTIFACT_UNVERIFIED" : !closed ? "PUMP_CLEANUP_PENDING" :
                    diagnostics.Stage == "prepare" || diagnostics.Stage == "template" ? "PUMP_PRECHECK_FAILED" : "PUMP_BUILD_FAILED";
                return diagnostics.Failure(code, saveAttempted || !closed ? "unknown" : "failed", "Revit did not finish generating the pump family.",
                    error: error, saveAttempted: saveAttempted, cleanupComplete: closed);
            }
            finally { currentApp = null; }
        }

        internal object Open(UIApplication app, Dictionary<string, object> args, DateTime expires, Func<bool> mayContinue)
        {
            var diagnostics = new PumpDiagnostics { Stage = "open" };
            object filename, sha256, bytes;
            if (args == null || args.Count != 3 || !args.TryGetValue("file_name", out filename) ||
                !args.TryGetValue("sha256", out sha256) || !args.TryGetValue("bytes", out bytes))
                return diagnostics.Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "A verified family file identity is required.", "invalid_artifact_identity");
            string name = filename as string, sha = sha256 as string;
            if (name == null || name.Length < 38 || name.Length > 85 ||
                !Regex.IsMatch(name.Substring(name.Length - 37), @"\A-[a-f0-9]{32}\.rfa\z") ||
                !ValidName(name.Substring(0, name.Length - 37)) ||
                sha == null || !Regex.IsMatch(sha, @"\A[a-f0-9]{64}\z") || !(bytes is int || bytes is long))
                return diagnostics.Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "The generated family file identity is invalid.", "invalid_artifact_identity");
            long expectedBytes = Convert.ToInt64(bytes, CultureInfo.InvariantCulture);
            string path = Path.Combine(artifacts, name);
            bool openAttempted = false;
            try
            {
                if (expectedBytes <= 0 || expectedBytes > MaxArtifactBytes)
                    return diagnostics.Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "The generated family file size is invalid.", "invalid_artifact_size");
                long length;
                if (VerifyFile(path, out length) != sha || length != expectedBytes)
                    return diagnostics.Failure("PUMP_ARTIFACT_CHANGED", "not_started", "The verified family file has changed.", "saved_file_changed");
                RequireContinue(expires, mayContinue);
                Document active = app.ActiveUIDocument == null ? null : app.ActiveUIDocument.Document;
                if (MatchesPath(active, path)) return new { success = true, opened = true };
                if (active != null && active.IsModifiable)
                    return diagnostics.Failure("PUMP_OPEN_HOST_BUSY", "not_started", "Finish the current Revit operation before opening the family.", "active_document_modifiable");
                openAttempted = true;
                UIDocument opened = app.OpenAndActivateDocument(path);
                if (opened == null || !MatchesPath(opened.Document, path) || app.ActiveUIDocument == null ||
                    !MatchesPath(app.ActiveUIDocument.Document, path))
                    return diagnostics.Failure("PUMP_OPEN_UNVERIFIED", "unknown", "Revit did not confirm activation of the generated family.", "activation_unverified");
                return new { success = true, opened = true };
            }
            catch (Exception error)
            {
                return diagnostics.Failure(openAttempted ? "PUMP_OPEN_UNVERIFIED" : "PUMP_OPEN_PRECHECK_FAILED",
                    openAttempted ? "unknown" : "not_started", "Revit did not finish opening the generated family.", error: error);
            }
        }

        private static bool MatchesPath(Document document, string path)
        {
            return document != null && document.IsValidObject && document.IsFamilyDocument && !String.IsNullOrEmpty(document.PathName) &&
                String.Equals(Path.GetFullPath(document.PathName), path, StringComparison.OrdinalIgnoreCase);
        }

        private static bool ValidName(string name)
        {
            if (String.IsNullOrEmpty(name) || name.Length > 48 ||
                Regex.IsMatch(name, @"\A(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
                return false;
            for (int position = 0; position < name.Length;)
            {
                UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(name, position);
                bool alphanumeric = category <= UnicodeCategory.OtherLetter ||
                    (category >= UnicodeCategory.DecimalDigitNumber && category <= UnicodeCategory.OtherNumber);
                if (!alphanumeric && (position == 0 || position == name.Length - 1 || " _-".IndexOf(name[position]) < 0))
                    return false;
                position += Char.IsSurrogatePair(name, position) ? 2 : 1;
            }
            return true;
        }

        private static void RequireContinue(DateTime expires, Func<bool> mayContinue)
        {
            if (DateTime.UtcNow >= expires || !mayContinue())
                throw new PumpValidationException("access_expired_or_cancelled");
        }

        private static List<Document> OpenDocuments(UIApplication app)
        { return app.Application.Documents.Cast<Document>().ToList(); }

        private void ClaimNewDocument(Document document, List<Document> before)
        {
            if (document == null || !document.IsValidObject || before.Any(old => old.IsValidObject && old.Equals(document)) ||
                currentApp.ActiveUIDocument != null && currentApp.ActiveUIDocument.Document.Equals(document))
                throw new PumpValidationException("family_document_not_owned");
            ownedDocument = document;
        }

        private bool CloseOwned()
        {
            if (ownedDocument == null) return true;
            try
            {
                if (ownedDocument.IsValidObject && (ownedDocument.IsModifiable ||
                    currentApp.ActiveUIDocument != null && currentApp.ActiveUIDocument.Document.Equals(ownedDocument) || !ownedDocument.Close(false)))
                    return false;
                ownedDocument = null;
                return true;
            }
            catch { return false; }
        }

        private static void Build(Document document, PumpSpec spec, PumpDiagnostics diagnostics)
        {
            RequireMechanicalFamily(document);
            if (Elements<ConnectorElement>(document).Any() || Elements<Extrusion>(document).Any())
                throw new PumpValidationException("unexpected_template_geometry");
            diagnostics.Stage = "family_parameters";
            FamilyManager manager = document.FamilyManager;
            manager.CurrentType = manager.NewType(TypeName);
            AddDimension(manager, "BuildX Width", spec.Width);
            AddDimension(manager, "BuildX Depth", spec.Depth);
            AddDimension(manager, "BuildX Height", spec.Height);
            FamilyParameter inletDiameter = AddDimension(manager, "BuildX Inlet Diameter", spec.Inlet);
            FamilyParameter outletDiameter = AddDimension(manager, "BuildX Outlet Diameter", spec.Outlet);

            double w = Ft(spec.Width), d = Ft(spec.Depth), h = Ft(spec.Height);
            double casingRadius = .27 * Math.Min(w, h), motorRadius = .20 * Math.Min(w, h);
            double axisHeight = h * .45;
            diagnostics.Stage = "geometry";
            var baseProfile = new CurveArray();
            XYZ[] corners = { XYZ.Zero, new XYZ(w, 0, 0), new XYZ(w, d, 0), new XYZ(0, d, 0) };
            for (int i = 0; i < corners.Length; i++)
                baseProfile.Append(Line.CreateBound(corners[i], corners[(i + 1) % corners.Length]));
            Extrude(document, baseProfile, XYZ.Zero, XYZ.BasisZ, h * .10);
            CircleExtrusion(document, new XYZ(w / 2, d * .15, axisHeight), XYZ.BasisZ, XYZ.BasisX, casingRadius, d * .38);
            CircleExtrusion(document, new XYZ(w / 2, d * .51, axisHeight), XYZ.BasisZ, XYZ.BasisX, motorRadius, d * .38);
            PortGeometryEvidence inletPort = DescribePort(spec, true);
            diagnostics.Geometry = inletPort;
            Extrusion inletBody = ExtrudePort(document, inletPort, XYZ.BasisZ, XYZ.BasisX);
            PortGeometryEvidence outletPort = DescribePort(spec, false);
            diagnostics.Geometry = outletPort;
            Extrusion outletBody = ExtrudePort(document, outletPort, XYZ.BasisY, XYZ.BasisX);
            diagnostics.Geometry = null;
            // Solid saddles bridge the schematic casing/motor to the base.
            Support(document, w, d * .25, d * .44, h * .10, axisHeight);
            Support(document, w, d * .61, d * .80, h * .10, axisHeight);
            diagnostics.Stage = "geometry_regenerate";
            document.Regenerate();

            diagnostics.Stage = "inlet_face";
            diagnostics.Geometry = inletPort;
            Reference inlet = FindCap(inletBody, inletPort);
            diagnostics.Stage = "inlet_connector";
            BindConnector(manager, ConnectorElement.CreatePipeConnector(document, spec.System, inlet), inletDiameter, spec.Inlet, FlowDirectionType.In, "Inlet");
            // Obtain the outlet reference after the inlet operation, including
            // regeneration by CreatePipeConnector and the size association.
            diagnostics.Stage = "outlet_face";
            diagnostics.Geometry = outletPort;
            document.Regenerate();
            Reference outlet = FindCap(outletBody, outletPort);
            diagnostics.Stage = "outlet_connector";
            BindConnector(manager, ConnectorElement.CreatePipeConnector(document, spec.System, outlet), outletDiameter, spec.Outlet, FlowDirectionType.Out, "Outlet");
            diagnostics.Geometry = null;
        }

        private static PortGeometryEvidence DescribePort(PumpSpec spec, bool inlet)
        {
            double w = Ft(spec.Width), d = Ft(spec.Depth), h = Ft(spec.Height);
            return inlet
                ? new PortGeometryEvidence("inlet", new XYZ(w / 2, 0, h * .45), -XYZ.BasisY, Ft(spec.Inlet) / 2, d * .19)
                : new PortGeometryEvidence("outlet", new XYZ(w / 2, d * .37, h), XYZ.BasisZ, Ft(spec.Outlet) / 2, h * .55);
        }

        private static FamilyParameter AddDimension(FamilyManager manager, string name, double mm)
        { return AddDimension(manager, name, mm, SpecTypeId.Length); }

        private static FamilyParameter AddDimension(FamilyManager manager, string name, double mm, ForgeTypeId spec)
        {
            FamilyParameter parameter = manager.AddParameter(name, GroupTypeId.Geometry, spec, false);
            manager.Set(parameter, Ft(mm));
            return parameter;
        }

        private static void Support(Document document, double width, double lowY, double highY, double z, double top)
        {
            var profile = new CurveArray();
            XYZ[] corners = { new XYZ(width * .42, lowY, z), new XYZ(width * .58, lowY, z),
                new XYZ(width * .58, highY, z), new XYZ(width * .42, highY, z) };
            for (int i = 0; i < corners.Length; i++) profile.Append(Line.CreateBound(corners[i], corners[(i + 1) % corners.Length]));
            Extrude(document, profile, corners[0], XYZ.BasisZ, top - z);
        }

        private static Extrusion CircleExtrusion(Document document, XYZ center, XYZ axis1, XYZ axis2, double radius, double length)
        { return Extrude(document, CircleProfile(center, axis1, axis2, radius), center, axis1.CrossProduct(axis2), length); }

        private static CurveArray CircleProfile(XYZ center, XYZ axis1, XYZ axis2, double radius)
        {
            var profile = new CurveArray();
            profile.Append(Arc.Create(center, radius, 0, Math.PI, axis1, axis2));
            profile.Append(Arc.Create(center, radius, Math.PI, 2 * Math.PI, axis1, axis2));
            return profile;
        }

        private static Extrusion Extrude(Document document, CurveArray profile, XYZ origin, XYZ normal, double length)
        {
            var loops = new CurveArrArray();
            loops.Append(profile);
            SketchPlane plane = SketchPlane.Create(document, Plane.CreateByNormalAndOrigin(normal, origin));
            return document.FamilyCreate.NewExtrusion(true, loops, plane, length);
        }

        private static Extrusion ExtrudePort(Document document, PortGeometryEvidence port, XYZ axis1, XYZ axis2)
        {
            XYZ inward = -port.Outward;
            var loops = new CurveArrArray();
            loops.Append(CircleProfile(port.Center, axis1, axis2, port.Radius));
            SketchPlane sketch = SketchPlane.Create(document, Plane.CreateByNormalAndOrigin(inward, port.Center));
            port.SketchNormal = sketch.GetPlane().Normal.Normalize();
            double alignment = port.SketchNormal.DotProduct(inward);
            if (Math.Abs(alignment) < .9999) throw new PumpValidationException("port_sketch_normal_mismatch");
            // Revit offsets are signed relative to its own sketch normal.
            return document.FamilyCreate.NewExtrusion(true, loops, sketch, alignment < 0 ? -port.Depth : port.Depth);
        }

        private static void VerifySketchOffsets(Extrusion extrusion, PortGeometryEvidence port)
        {
            XYZ inward = -port.Outward;
            Plane used = extrusion.Sketch.SketchPlane.GetPlane();
            port.SketchNormal = used.Normal.Normalize();
            if (Math.Abs(port.SketchNormal.DotProduct(inward)) < .9999)
                throw new PumpValidationException("port_sketch_normal_mismatch");
            port.StartOffset = extrusion.StartOffset;
            port.EndOffset = extrusion.EndOffset;
            double start = (used.Origin + port.SketchNormal * port.StartOffset.Value - port.Center).DotProduct(inward);
            double end = (used.Origin + port.SketchNormal * port.EndOffset.Value - port.Center).DotProduct(inward);
            // Some native representations normalize the offset order. Check
            // the two physical planes rather than relying on their labels.
            if (Math.Abs(Math.Min(start, end)) > Ft(ToleranceMm) || Math.Abs(Math.Max(start, end) - port.Depth) > Ft(ToleranceMm))
                throw new PumpValidationException("port_end_plane_mismatch");
        }

        private static Reference FindCap(Extrusion extrusion, PortGeometryEvidence port)
        {
            VerifySketchOffsets(extrusion, port);
            Reference found = null;
            double tolerance = Ft(ToleranceMm);
            foreach (LocatedSolid solid in Solids(extrusion, true, port))
                foreach (Face face in solid.Shape.Faces)
                {
                    PlanarFace cap = face as PlanarFace;
                    if (cap == null) continue;
                    port.Planar++;
                    Reference nativeReference = cap.Reference;
                    if (nativeReference != null) port.Referenced++;
                    XYZ normal = solid.ToFamily.OfVector(cap.FaceNormal).Normalize();
                    double axisDelta = (solid.ToFamily.OfPoint(cap.Origin) - port.Center).DotProduct(port.Outward);
                    double? actualRadius;
                    string rejected = RejectedCap(cap, solid.ToFamily, port, tolerance, normal, axisDelta, nativeReference != null, out actualRadius);
                    if (rejected == "none")
                    {
                        port.Matched++;
                        found = nativeReference;
                    }
                    port.AddCandidate(normal, axisDelta, actualRadius, nativeReference != null, rejected);
                }
            if (port.Solids == 0) throw new PumpValidationException("port_geometry_missing");
            if (port.Planar == 0) throw new PumpValidationException("port_planar_face_missing");
            if (port.Aligned == 0) throw new PumpValidationException("port_face_normal_mismatch");
            if (port.Coplanar == 0) throw new PumpValidationException("port_end_plane_mismatch");
            if (port.Circular == 0) throw new PumpValidationException("port_circular_profile_mismatch");
            if (port.Matched == 0) throw new PumpValidationException("port_reference_missing");
            if (port.Matched != 1) throw new PumpValidationException("port_face_ambiguous");
            return found;
        }

        private static string RejectedCap(PlanarFace cap, Transform toFamily, PortGeometryEvidence port, double tolerance,
            XYZ normal, double axisDelta, bool hasReference, out double? actualRadius)
        {
            actualRadius = null;
            if (normal.DotProduct(port.Outward) < .9999) return "normal";
            port.Aligned++;
            if (Math.Abs(axisDelta) > tolerance) return "plane";
            port.Coplanar++;
            XYZ center;
            double radius;
            if (!TryCircularBoundary(cap, toFamily, tolerance, out center, out radius)) return "boundary";
            actualRadius = radius;
            if (center.DistanceTo(port.Center) > tolerance) return "center";
            if (Math.Abs(radius - port.Radius) > tolerance) return "radius";
            port.Circular++;
            return hasReference ? "none" : "reference";
        }

        private static bool TryCircularBoundary(PlanarFace face, Transform toFamily, double tolerance, out XYZ center, out double radius)
        {
            center = null;
            radius = 0;
            // Revit returns closed boundary loops. One loop of arcs with a
            // common center and radius is a disk, even with split native edges.
            IList<CurveLoop> loops = face.GetEdgesAsCurveLoops();
            if (loops.Count != 1) return false;
            foreach (Curve edge in loops[0])
            {
                Arc arc = edge as Arc;
                if (arc == null) return false;
                XYZ actualCenter = toFamily.OfPoint(arc.Center);
                XYZ axisX = toFamily.OfVector(arc.XDirection);
                XYZ axisY = toFamily.OfVector(arc.YDirection);
                double radiusX = axisX.GetLength() * arc.Radius;
                double radiusY = axisY.GetLength() * arc.Radius;
                if (!(radiusX > 0) || !(radiusY > 0) || Math.Abs(radiusX - radiusY) > tolerance ||
                    Math.Abs(axisX.Normalize().DotProduct(axisY.Normalize())) > .0001) return false;
                if (center != null && (center.DistanceTo(actualCenter) > tolerance || Math.Abs(radius - radiusX) > tolerance))
                    return false;
                center = actualCenter;
                radius = radiusX;
            }
            return center != null;
        }

        private static void BindConnector(FamilyManager manager, ConnectorElement connector, FamilyParameter diameter, double sizeMm, FlowDirectionType flow, string label)
        {
            if (connector == null || connector.Domain != Domain.DomainPiping)
                throw new PumpValidationException("port_classification_mismatch");
            Parameter direction = connector.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
            if (direction == null || direction.StorageType != StorageType.Integer ||
                (direction.AsInteger() != (int)flow && (direction.IsReadOnly || !direction.Set((int)flow))))
                throw new PumpValidationException("port_flow_unavailable");
            Parameter description = connector.get_Parameter(BuiltInParameter.RBS_CONNECTOR_DESCRIPTION);
            if (description != null && !description.IsReadOnly) description.Set("BuildX " + label);

            Parameter radius = connector.get_Parameter(BuiltInParameter.CONNECTOR_RADIUS);
            Parameter nativeDiameter = connector.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER);
            if (!BindPortSize(manager, radius, null, "BuildX " + label + " Radius", sizeMm / 2) &&
                !BindPortSize(manager, nativeDiameter, diameter, "BuildX " + label + " Connector Diameter", sizeMm))
                throw new PumpValidationException("port_size_unavailable");
        }

        private static bool BindPortSize(FamilyManager manager, Parameter nativeSize, FamilyParameter metadata, string name, double mm)
        {
            if (nativeSize == null || nativeSize.StorageType != StorageType.Double) return false;
            ForgeTypeId spec = nativeSize.Definition.GetDataType();
            if (!UnitUtils.IsMeasurableSpec(spec) || !UnitUtils.IsValidUnit(spec, UnitTypeId.Millimeters)) return false;
            if (manager.CanElementParameterBeAssociated(nativeSize))
            {
                FamilyParameter familySize = metadata != null && metadata.Definition.GetDataType() == spec
                    ? metadata : AddDimension(manager, name, mm, spec);
                manager.AssociateElementParameterToFamilyParameter(nativeSize, familySize);
                return true;
            }
            return !nativeSize.IsReadOnly && (Math.Abs(Mm(nativeSize.AsDouble()) - mm) <= ToleranceMm || nativeSize.Set(Ft(mm)));
        }

        private static object[] Inspect(Document document, PumpSpec spec)
        {
            RequireMechanicalFamily(document);
            FamilyManager manager = document.FamilyManager;
            FamilyType type = manager.Types.Cast<FamilyType>().FirstOrDefault(item => item.Name == TypeName);
            if (type == null) throw new PumpValidationException("family_type_missing");
            foreach (var target in new[] {
                new KeyValuePair<string,double>("Width", spec.Width), new KeyValuePair<string,double>("Depth", spec.Depth),
                new KeyValuePair<string,double>("Height", spec.Height), new KeyValuePair<string,double>("Inlet Diameter", spec.Inlet),
                new KeyValuePair<string,double>("Outlet Diameter", spec.Outlet) })
            {
                FamilyParameter parameter = manager.get_Parameter("BuildX " + target.Key);
                double? actual = parameter == null ? null : type.AsDouble(parameter);
                if (!actual.HasValue || Math.Abs(Mm(actual.Value) - target.Value) > ToleranceMm)
                    throw new PumpValidationException("type_parameter_value_mismatch");
            }
            Extrusion[] forms = Elements<Extrusion>(document).ToArray();
            LocatedSolid[][] solids = forms.Select(form => Solids(form, false).ToArray()).ToArray();
            if (solids.Length != 7 || solids.Any(form => form.Length == 0))
                throw new PumpValidationException("solid_geometry_missing");
            VerifyBounds(solids.SelectMany(form => form), spec);

            ConnectorElement[] connectors = Elements<ConnectorElement>(document).ToArray();
            if (connectors.Length != 2) throw new PumpValidationException("port_count_mismatch");
            PortGeometryEvidence inlet = DescribePort(spec, true), outlet = DescribePort(spec, false);
            return new[] {
                InspectConnector(connectors, inlet.Center, inlet.Outward, spec.Inlet, spec.Classification, FlowDirectionType.In),
                InspectConnector(connectors, outlet.Center, outlet.Outward, spec.Outlet, spec.Classification, FlowDirectionType.Out)
            };
        }

        private static void VerifyBounds(IEnumerable<LocatedSolid> solids, PumpSpec spec)
        {
            var points = new List<XYZ>();
            foreach (LocatedSolid solid in solids)
            {
                // Solid bounds are local to their transform. Element bounds can
                // additionally include controls that are not pump geometry.
                BoundingBoxXYZ box = solid.Shape.GetBoundingBox();
                if (box == null) throw new PumpValidationException("solid_geometry_missing");
                Transform toFamily = solid.ToFamily.Multiply(box.Transform);
                foreach (double x in new[] { box.Min.X, box.Max.X })
                foreach (double y in new[] { box.Min.Y, box.Max.Y })
                foreach (double z in new[] { box.Min.Z, box.Max.Z })
                    points.Add(toFamily.OfPoint(new XYZ(x, y, z)));
            }
            XYZ minimum = new XYZ(points.Min(point => point.X), points.Min(point => point.Y), points.Min(point => point.Z));
            XYZ maximum = new XYZ(points.Max(point => point.X), points.Max(point => point.Y), points.Max(point => point.Z));
            if (minimum.DistanceTo(XYZ.Zero) > Ft(ToleranceMm) ||
                maximum.DistanceTo(new XYZ(Ft(spec.Width), Ft(spec.Depth), Ft(spec.Height))) > Ft(ToleranceMm))
                throw new PumpValidationException("geometry_bounds_mismatch");
        }

        private static object InspectConnector(ConnectorElement[] connectors, XYZ position, XYZ normal, double diameter, MEPSystemClassification classification, FlowDirectionType flow)
        {
            ConnectorElement item = connectors.FirstOrDefault(connector => connector.Origin.DistanceTo(position) <= Ft(ToleranceMm));
            if (item == null) throw new PumpValidationException("port_origin_mismatch");
            if (item.Domain != Domain.DomainPiping || item.Shape != ConnectorProfileType.Round || item.SystemClassification != classification)
                throw new PumpValidationException("port_classification_mismatch");
            if (item.CoordinateSystem.BasisZ.Normalize().DotProduct(normal) < .9999)
                throw new PumpValidationException("port_normal_mismatch");
            double actualDiameter = Mm(item.Radius * 2);
            if (Math.Abs(actualDiameter - diameter) > ToleranceMm)
                throw new PumpValidationException("port_diameter_mismatch");
            Parameter direction = item.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
            if (direction == null || direction.StorageType != StorageType.Integer || direction.AsInteger() != (int)flow)
                throw new PumpValidationException("port_flow_mismatch");
            return new { flow = flow.ToString(), system = item.SystemClassification.ToString(), diameter_mm = actualDiameter,
                origin_mm = new[] { Mm(item.Origin.X), Mm(item.Origin.Y), Mm(item.Origin.Z) } };
        }

        private static void RequireMechanicalFamily(Document document)
        {
            if (document == null || !document.IsValidObject || !document.IsFamilyDocument || document.OwnerFamily == null ||
                document.OwnerFamily.FamilyCategory == null || document.OwnerFamily.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_MechanicalEquipment)
                throw new PumpValidationException("family_category_mismatch");
        }

        private static IEnumerable<T> Elements<T>(Document document) where T : Element
        { return new FilteredElementCollector(document).OfClass(typeof(T)).Cast<T>(); }

        private static IEnumerable<LocatedSolid> Solids(Extrusion form, bool references, PortGeometryEvidence port = null)
        {
            GeometryElement geometry = form.get_Geometry(new Options { ComputeReferences = references, DetailLevel = ViewDetailLevel.Fine });
            return Solids(geometry, Transform.Identity, port, 0);
        }

        private static IEnumerable<LocatedSolid> Solids(GeometryElement geometry, Transform toFamily, PortGeometryEvidence port, int depth)
        {
            if (geometry == null) yield break;
            if (depth > 8) throw new PumpValidationException("native_geometry_depth_exceeded");
            foreach (GeometryObject item in geometry)
            {
                Solid solid = item as Solid;
                if (solid != null && solid.Volume > 0)
                {
                    if (port != null) port.Solids++;
                    yield return new LocatedSolid(solid, toFamily);
                }
                GeometryInstance instance = item as GeometryInstance;
                if (instance == null) continue;
                if (port != null) port.Instances++;
                // Transformed copies can lose linkable references. Traverse
                // the original symbol and transform only reported geometry.
                foreach (LocatedSolid nested in Solids(instance.GetSymbolGeometry(), toFamily.Multiply(instance.Transform), port, depth + 1))
                    yield return nested;
            }
        }

        private static double Ft(double mm) { return UnitUtils.ConvertToInternalUnits(mm, UnitTypeId.Millimeters); }
        private static double Mm(double feet) { return UnitUtils.ConvertFromInternalUnits(feet, UnitTypeId.Millimeters); }
        private static string Hex(byte[] digest) { return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant(); }
        private static string Sha256(byte[] input)
        { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(input)); }

        private static bool Exists(string filename)
        {
            try { File.GetAttributes(filename); return true; }
            catch (FileNotFoundException) { return false; }
        }

        private static string VerifyFile(string path, out long length)
        {
            RequirePlainDirectoryChain(Path.GetDirectoryName(path));
            RequirePlainFile(path);
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var sha = SHA256.Create())
            {
                length = stream.Length;
                if (length <= 0 || length > MaxArtifactBytes)
                    throw new IOException("Pump family file size is invalid.");
                string digest = Hex(sha.ComputeHash(stream));
                if (stream.Position != length || stream.Length != length)
                    throw new IOException("Pump family file changed while verifying.");
                return digest;
            }
        }

        private static void RequirePlainFile(string file)
        {
            if ((File.GetAttributes(file) & UnsafeFile) != 0) throw new IOException("Unexpected file type.");
        }

        private static void RequirePlainDirectoryChain(string directory)
        {
            for (string candidate = Path.GetFullPath(directory); !String.IsNullOrEmpty(candidate); candidate = Path.GetDirectoryName(candidate))
            {
                FileAttributes attrs = File.GetAttributes(candidate);
                if ((attrs & FileAttributes.Directory) == 0 || (attrs & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Unexpected folder type.");
            }
        }
    }
}

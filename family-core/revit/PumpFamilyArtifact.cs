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
        private const double MmPerFoot = 304.8;
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

        private sealed class RejectErrors : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                var messages = accessor.GetFailureMessages();
                if (messages.Any(item => item.GetSeverity() >= FailureSeverity.Error))
                    return FailureProcessingResult.ProceedWithRollBack;
                foreach (FailureMessageAccessor item in messages)
                    if (item.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(item);
                return FailureProcessingResult.Continue;
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
            PumpSpec spec;
            Guid request;
            try
            {
                spec = PumpSpec.Parse(args);
                if (!Guid.TryParseExact(id, "D", out request)) throw new InvalidOperationException("Invalid pump request identity.");
            }
            catch (InvalidOperationException error) { return Failure("PUMP_INPUT_INVALID", "not_started", error.Message); }

            currentApp = app;
            bool saveAttempted = false;
            string name = spec.Name + "-" + request.ToString("N") + ".rfa";
            string output = Path.Combine(artifacts, name);
            string stage = "prepare";
            try
            {
                if (!CloseOwned())
                    return Failure("PUMP_CLEANUP_PENDING", "not_started", "A previous family document still needs cleanup.");
                RequireContinue(expires, mayContinue);
                RequirePlainDirectoryChain(Path.GetDirectoryName(artifacts));
                Directory.CreateDirectory(artifacts);
                RequirePlainDirectoryChain(artifacts);
                if (Exists(output))
                    return Failure("PUMP_OUTPUT_EXISTS", "unknown", "This request already has an output. Check its original receipt.");
                var template = templates.Inspect(TemplateId);
                if (template.State != FamilyTemplateState.BytesVerified ||
                    String.IsNullOrEmpty(template.SourcePath) || String.IsNullOrEmpty(template.Sha256))
                    return Failure("PUMP_TEMPLATE_UNAVAILABLE", "not_started", "The configured Revit directory needs a metric Mechanical Equipment family template.");

                stage = "build";
                List<Document> existing = OpenDocuments(app);
                Document family = app.Application.NewFamilyDocument(template.SourcePath);
                ClaimNewDocument(family, existing);
                using (var transaction = new Transaction(family, "BuildX pump family"))
                {
                    if (transaction.Start() != TransactionStatus.Started)
                        throw new InvalidOperationException("Pump family transaction could not start.");
                    var settings = transaction.GetFailureHandlingOptions();
                    settings.SetFailuresPreprocessor(new RejectErrors());
                    settings.SetClearAfterRollback(true);
                    transaction.SetFailureHandlingOptions(settings);
                    Build(family, spec);
                    Inspect(family, spec);
                    RequireContinue(expires, mayContinue);
                    if (transaction.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("Pump family transaction did not commit.");
                }

                stage = "save";
                RequireContinue(expires, mayContinue);
                RequirePlainDirectoryChain(artifacts);
                if (Exists(output)) throw new IOException("The pump family file name is already in use.");
                saveAttempted = true;
                using (var options = new SaveAsOptions { OverwriteExistingFile = false, MaximumBackups = 1 })
                    family.SaveAs(output, options);
                if (!CloseOwned()) throw new InvalidOperationException("The new family document could not be closed.");
                long bytes;
                string sha = VerifyFile(output, out bytes);

                stage = "reopen";
                existing = OpenDocuments(app);
                Document reopened = app.Application.OpenDocumentFile(output);
                ClaimNewDocument(reopened, existing);
                if (!String.Equals(Path.GetFullPath(reopened.PathName), output, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Revit reopened a different document.");
                object[] connectors = Inspect(reopened, spec);
                if (!CloseOwned()) throw new InvalidOperationException("The verification document could not be closed.");
                long afterBytes;
                if (VerifyFile(output, out afterBytes) != sha || bytes != afterBytes)
                    throw new IOException("The saved RFA changed during verification.");
                return new { success = true, file_name = name, sha256 = sha, bytes, reopened = true, family_category = "MechanicalEquipment", type_name = TypeName,
                    width_mm = spec.Width, depth_mm = spec.Depth, height_mm = spec.Height, connectors };
            }
            catch (Exception error)
            {
                bool closed = CloseOwned();
                string code = saveAttempted ? "PUMP_ARTIFACT_UNVERIFIED" : !closed ? "PUMP_CLEANUP_PENDING" :
                    stage == "prepare" ? "PUMP_PRECHECK_FAILED" : "PUMP_BUILD_FAILED";
                return Failure(code, saveAttempted || !closed ? "unknown" : "failed", stage + " (" + error.GetType().Name + ")");
            }
            finally { currentApp = null; }
        }

        internal object Open(UIApplication app, Dictionary<string, object> args, DateTime expires, Func<bool> mayContinue)
        {
            object filename, sha256, bytes;
            if (args == null || args.Count != 3 || !args.TryGetValue("file_name", out filename) ||
                !args.TryGetValue("sha256", out sha256) || !args.TryGetValue("bytes", out bytes))
                return Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "A verified family file identity is required.");
            string name = filename as string, sha = sha256 as string;
            if (name == null || name.Length < 38 || name.Length > 85 ||
                !Regex.IsMatch(name.Substring(name.Length - 37), @"\A-[a-f0-9]{32}\.rfa\z") ||
                !ValidName(name.Substring(0, name.Length - 37)) ||
                sha == null || !Regex.IsMatch(sha, @"\A[a-f0-9]{64}\z") || !(bytes is int || bytes is long))
                return Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "The generated family file identity is invalid.");
            long expectedBytes = Convert.ToInt64(bytes, CultureInfo.InvariantCulture);
            string path = Path.Combine(artifacts, name);
            bool openAttempted = false;
            try
            {
                if (expectedBytes <= 0 || expectedBytes > MaxArtifactBytes)
                    return Failure("PUMP_ARTIFACT_ID_INVALID", "not_started", "The generated family file size is invalid.");
                long length;
                if (VerifyFile(path, out length) != sha || length != expectedBytes)
                    return Failure("PUMP_ARTIFACT_CHANGED", "not_started", "The verified family file has changed.");
                RequireContinue(expires, mayContinue);
                Document active = app.ActiveUIDocument == null ? null : app.ActiveUIDocument.Document;
                if (MatchesPath(active, path)) return new { success = true, opened = true };
                if (active != null && active.IsModifiable)
                    return Failure("PUMP_OPEN_HOST_BUSY", "not_started", "Finish the current Revit operation before opening the family.");
                openAttempted = true;
                UIDocument opened = app.OpenAndActivateDocument(path);
                if (opened == null || !MatchesPath(opened.Document, path) || app.ActiveUIDocument == null ||
                    !MatchesPath(app.ActiveUIDocument.Document, path))
                    return Failure("PUMP_OPEN_UNVERIFIED", "unknown", "Revit did not confirm activation of the generated family.");
                return new { success = true, opened = true };
            }
            catch (Exception error)
            {
                return Failure(openAttempted ? "PUMP_OPEN_UNVERIFIED" : "PUMP_OPEN_PRECHECK_FAILED",
                    openAttempted ? "unknown" : "not_started", "Open family (" + error.GetType().Name + ")");
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

        private static object Failure(string code, string outcome, string message)
        { return new { success = false, code, outcome, message }; }

        private static void RequireContinue(DateTime expires, Func<bool> mayContinue)
        {
            if (DateTime.UtcNow >= expires || !mayContinue())
                throw new InvalidOperationException("The approved pump request expired or was cancelled.");
        }

        private static List<Document> OpenDocuments(UIApplication app)
        { return app.Application.Documents.Cast<Document>().ToList(); }

        private void ClaimNewDocument(Document document, List<Document> before)
        {
            if (document == null || !document.IsValidObject || before.Any(old => old.IsValidObject && old.Equals(document)) ||
                currentApp.ActiveUIDocument != null && currentApp.ActiveUIDocument.Document.Equals(document))
                throw new InvalidOperationException("Revit did not return a separate, owned document.");
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

        private static void Build(Document document, PumpSpec spec)
        {
            RequireMechanicalFamily(document);
            if (Elements<ConnectorElement>(document).Any() || Elements<Extrusion>(document).Any())
                throw new InvalidOperationException("The pump template must have no model geometry or connectors.");
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
            var baseProfile = new CurveArray();
            XYZ[] corners = { XYZ.Zero, new XYZ(w, 0, 0), new XYZ(w, d, 0), new XYZ(0, d, 0) };
            for (int i = 0; i < corners.Length; i++)
                baseProfile.Append(Line.CreateBound(corners[i], corners[(i + 1) % corners.Length]));
            Extrude(document, baseProfile, XYZ.Zero, XYZ.BasisZ, h * .10);
            CircleExtrusion(document, new XYZ(w / 2, d * .15, axisHeight), XYZ.BasisZ, XYZ.BasisX, casingRadius, d * .38);
            CircleExtrusion(document, new XYZ(w / 2, d * .51, axisHeight), XYZ.BasisZ, XYZ.BasisX, motorRadius, d * .38);
            CircleExtrusion(document, new XYZ(w / 2, d * .19, axisHeight), XYZ.BasisX, XYZ.BasisZ, Ft(spec.Inlet) / 2, d * .19);
            CircleExtrusion(document, new XYZ(w / 2, d * .37, axisHeight), XYZ.BasisX, XYZ.BasisY, Ft(spec.Outlet) / 2, h - axisHeight);
            // Solid saddles bridge the schematic casing/motor to the base.
            Support(document, w, d * .25, d * .44, h * .10, axisHeight);
            Support(document, w, d * .61, d * .80, h * .10, axisHeight);
            document.Regenerate();

            Reference inlet = FindCap(document, new XYZ(w / 2, 0, axisHeight), -XYZ.BasisY, Ft(spec.Inlet) / 2);
            Reference outlet = FindCap(document, new XYZ(w / 2, d * .37, h), XYZ.BasisZ, Ft(spec.Outlet) / 2);
            BindConnector(document, ConnectorElement.CreatePipeConnector(document, spec.System, inlet), inletDiameter, FlowDirectionType.In, "Inlet");
            BindConnector(document, ConnectorElement.CreatePipeConnector(document, spec.System, outlet), outletDiameter, FlowDirectionType.Out, "Outlet");
            document.Regenerate();
        }

        private static FamilyParameter AddDimension(FamilyManager manager, string name, double mm)
        {
            FamilyParameter parameter = AddLength(manager, name);
            manager.SetFormula(parameter, mm.ToString("0.################", CultureInfo.InvariantCulture) + " mm");
            return parameter;
        }

        private static FamilyParameter AddLength(FamilyManager manager, string name)
        { return manager.AddParameter(name, GroupTypeId.Geometry, SpecTypeId.Length, false); }

        private static void Support(Document document, double width, double lowY, double highY, double z, double top)
        {
            var profile = new CurveArray();
            XYZ[] corners = { new XYZ(width * .42, lowY, z), new XYZ(width * .58, lowY, z),
                new XYZ(width * .58, highY, z), new XYZ(width * .42, highY, z) };
            for (int i = 0; i < corners.Length; i++) profile.Append(Line.CreateBound(corners[i], corners[(i + 1) % corners.Length]));
            Extrude(document, profile, corners[0], XYZ.BasisZ, top - z);
        }

        private static void CircleExtrusion(Document document, XYZ center, XYZ axis1, XYZ axis2, double radius, double length)
        {
            var profile = new CurveArray();
            profile.Append(Arc.Create(center, radius, 0, Math.PI, axis1, axis2));
            profile.Append(Arc.Create(center, radius, Math.PI, 2 * Math.PI, axis1, axis2));
            Extrude(document, profile, center, axis1.CrossProduct(axis2), length);
        }

        private static void Extrude(Document document, CurveArray profile, XYZ origin, XYZ normal, double length)
        {
            var loops = new CurveArrArray();
            loops.Append(profile);
            SketchPlane plane = SketchPlane.Create(document, Plane.CreateByNormalAndOrigin(normal, origin));
            document.FamilyCreate.NewExtrusion(true, loops, plane, length);
        }

        private static Reference FindCap(Document document, XYZ expected, XYZ normal, double radius)
        {
            Reference found = null;
            foreach (Extrusion extrusion in Elements<Extrusion>(document))
                foreach (Solid solid in Solids(extrusion, true))
                    foreach (Face face in solid.Faces)
                    {
                        PlanarFace cap = face as PlanarFace;
                        if (cap == null || cap.Reference == null || cap.FaceNormal.DotProduct(normal) < .9999 ||
                            Math.Abs((cap.Origin - expected).DotProduct(normal)) > Ft(.1) ||
                            Math.Abs(cap.Area - Math.PI * radius * radius) > Math.PI * radius * radius * .0001) continue;
                        IntersectionResult projected = cap.Project(expected);
                        if (projected == null || projected.Distance > Ft(.1)) continue;
                        if (found != null) throw new InvalidOperationException("Pump port geometry has an ambiguous cap reference.");
                        found = cap.Reference;
                    }
            if (found == null) throw new InvalidOperationException("A native circular pump port face was not found.");
            return found;
        }

        private static void BindConnector(Document document, ConnectorElement connector, FamilyParameter diameter, FlowDirectionType flow, string label)
        {
            FamilyManager manager = document.FamilyManager;
            Parameter direction = connector.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
            if (direction == null || direction.StorageType != StorageType.Integer ||
                (direction.AsInteger() != (int)flow && (direction.IsReadOnly || !direction.Set((int)flow))))
                throw new InvalidOperationException("Pump connector flow direction could not be assigned.");
            Parameter description = connector.get_Parameter(BuiltInParameter.RBS_CONNECTOR_DESCRIPTION);
            if (description != null && !description.IsReadOnly) description.Set("BuildX " + label);

            Parameter nativeSize = connector.get_Parameter(BuiltInParameter.CONNECTOR_DIAMETER);
            FamilyParameter familySize = diameter;
            if (nativeSize == null || !manager.CanElementParameterBeAssociated(nativeSize))
            {
                nativeSize = connector.get_Parameter(BuiltInParameter.CONNECTOR_RADIUS);
                if (nativeSize == null || !manager.CanElementParameterBeAssociated(nativeSize))
                    throw new InvalidOperationException("Pump connector cannot be associated with a family size.");
                familySize = AddLength(manager, "BuildX " + label + " Radius");
                manager.SetFormula(familySize, diameter.Definition.Name + " / 2");
            }
            manager.AssociateElementParameterToFamilyParameter(nativeSize, familySize);
        }

        private static object[] Inspect(Document document, PumpSpec spec)
        {
            RequireMechanicalFamily(document);
            FamilyManager manager = document.FamilyManager;
            FamilyType type = manager.Types.Cast<FamilyType>().Single(item => item.Name == TypeName);
            foreach (var target in new[] {
                new KeyValuePair<string,double>("Width", spec.Width), new KeyValuePair<string,double>("Depth", spec.Depth),
                new KeyValuePair<string,double>("Height", spec.Height), new KeyValuePair<string,double>("Inlet Diameter", spec.Inlet),
                new KeyValuePair<string,double>("Outlet Diameter", spec.Outlet) })
            {
                FamilyParameter parameter = manager.get_Parameter("BuildX " + target.Key);
                double? actual = parameter == null ? null : type.AsDouble(parameter);
                if (!actual.HasValue || Math.Abs(actual.Value * MmPerFoot - target.Value) > .1)
                    throw new InvalidOperationException("A saved pump family dimension does not match the request.");
            }
            Extrusion[] forms = Elements<Extrusion>(document).ToArray();
            if (forms.Length != 7 || forms.Any(form => !Solids(form, false).Any()))
                throw new InvalidOperationException("The saved pump family is missing expected solid geometry.");
            VerifyBounds(forms, spec);

            ConnectorElement[] connectors = Elements<ConnectorElement>(document).ToArray();
            if (connectors.Length != 2) throw new InvalidOperationException("The pump family must have exactly two connectors.");
            double w = Ft(spec.Width), d = Ft(spec.Depth), h = Ft(spec.Height);
            return new[] {
                InspectConnector(connectors, new XYZ(w / 2, 0, h * .45), -XYZ.BasisY, spec.Inlet, spec.Classification, FlowDirectionType.In),
                InspectConnector(connectors, new XYZ(w / 2, d * .37, h), XYZ.BasisZ, spec.Outlet, spec.Classification, FlowDirectionType.Out)
            };
        }

        private static void VerifyBounds(Extrusion[] forms, PumpSpec spec)
        {
            var points = new List<XYZ>();
            foreach (Extrusion form in forms)
            {
                BoundingBoxXYZ box = form.get_BoundingBox(null);
                if (box == null) throw new InvalidOperationException("A pump solid has no geometry bounds.");
                foreach (double x in new[] { box.Min.X, box.Max.X })
                foreach (double y in new[] { box.Min.Y, box.Max.Y })
                foreach (double z in new[] { box.Min.Z, box.Max.Z })
                    points.Add(box.Transform.OfPoint(new XYZ(x, y, z)));
            }
            XYZ minimum = new XYZ(points.Min(point => point.X), points.Min(point => point.Y), points.Min(point => point.Z));
            XYZ maximum = new XYZ(points.Max(point => point.X), points.Max(point => point.Y), points.Max(point => point.Z));
            if (minimum.DistanceTo(XYZ.Zero) > Ft(.1) ||
                maximum.DistanceTo(new XYZ(Ft(spec.Width), Ft(spec.Depth), Ft(spec.Height))) > Ft(.1))
                throw new InvalidOperationException("The saved pump geometry bounds do not match the requested size.");
        }

        private static object InspectConnector(ConnectorElement[] connectors, XYZ position, XYZ normal, double diameter, MEPSystemClassification classification, FlowDirectionType flow)
        {
            ConnectorElement item = connectors.Single(connector => {
                Parameter direction = connector.get_Parameter(BuiltInParameter.RBS_PIPE_FLOW_DIRECTION_PARAM);
                return direction != null && direction.StorageType == StorageType.Integer && direction.AsInteger() == (int)flow;
            });
            if (item.Domain != Domain.DomainPiping || item.Shape != ConnectorProfileType.Round || item.SystemClassification != classification ||
                item.Origin.DistanceTo(position) > Ft(.1) || item.CoordinateSystem.BasisZ.Normalize().DotProduct(normal) < .9999 ||
                Math.Abs(item.Radius * (2 * MmPerFoot) - diameter) > .1)
                throw new InvalidOperationException("A saved native pipe connector does not match the approved type, position or size.");
            return new { flow = flow.ToString(), system = item.SystemClassification.ToString(), diameter_mm = item.Radius * (2 * MmPerFoot),
                origin_mm = new[] { item.Origin.X * MmPerFoot, item.Origin.Y * MmPerFoot, item.Origin.Z * MmPerFoot } };
        }

        private static void RequireMechanicalFamily(Document document)
        {
            if (document == null || !document.IsValidObject || !document.IsFamilyDocument || document.OwnerFamily == null ||
                document.OwnerFamily.FamilyCategory == null || document.OwnerFamily.FamilyCategory.Id.Value != (long)BuiltInCategory.OST_MechanicalEquipment)
                throw new InvalidOperationException("The selected Revit template is not a mechanical equipment family.");
        }

        private static IEnumerable<T> Elements<T>(Document document) where T : Element
        { return new FilteredElementCollector(document).OfClass(typeof(T)).Cast<T>(); }

        private static IEnumerable<Solid> Solids(Extrusion form, bool references)
        {
            GeometryElement geometry = form.get_Geometry(new Options { ComputeReferences = references, DetailLevel = ViewDetailLevel.Fine });
            return geometry == null ? Enumerable.Empty<Solid>() : geometry.OfType<Solid>().Where(solid => solid.Volume > 0);
        }

        private static double Ft(double mm) { return mm / MmPerFoot; }
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

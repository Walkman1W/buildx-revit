using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Self-authored BuildX implementation. Invoke only from a Revit API context.
    // Preview is read-only; Export owns one transaction inside the host's group.
    internal static class SchematicRevitService
    {
        private const int MaxConnectorsPerElement = 4096;
        private const int MaxReferencesPerConnector = 4096;
        private const int MaxConnectorReferences = 24000;
        private const double FeetPerMillimetre = 1.0 / 304.8;

        internal static object ReadPipeNetwork(Document doc, Dictionary<string, object> args)
        {
            if (doc == null || doc.IsFamilyDocument) throw new InvalidOperationException("Pipe networks require an active Revit project document.");
            long rootId = NativeModelQueries.ExactId(args, "start_element_id");
            int maxHops = 6;
            object hopsValue;
            if (args.TryGetValue("max_hops", out hopsValue))
            {
                if (hopsValue is string) throw new InvalidOperationException("max_hops must be an integer from 1 to 12.");
                long requestedHops = NativeModelQueries.ExactId(args, "max_hops");
                if (requestedHops > 12) throw new InvalidOperationException("max_hops must be an integer from 1 to 12.");
                maxHops = (int)requestedHops;
            }

            var root = doc.GetElement(new ElementId(rootId)) as FamilyInstance;
            if (root == null || !Connectors(root).Any(IsPhysicalPipeConnector))
                throw new InvalidOperationException("Select a family instance with physical piping connectors, such as a pump.");

            var depths = new Dictionary<long, int> { { rootId, 0 } };
            var nodes = new SortedDictionary<long, object> { { rootId, PipeNetworkNode(root, "root", 0) } };
            var edges = new SortedDictionary<string, object>(StringComparer.Ordinal);
            var queue = new Queue<Element>();
            queue.Enqueue(root);
            int inspectedConnectors = 0;
            int inspectedReferences = 0;
            bool boundaryReached = false;

            while (queue.Count > 0)
            {
                Element element = queue.Dequeue();
                long elementId = element.Id.Value;
                int hop = depths[elementId];
                foreach (Connector connector in Connectors(element))
                {
                    if (++inspectedConnectors > MaxConnectorReferences)
                        throw new InvalidOperationException("The pipe network exceeds the connector inspection budget. Request fewer hops.");
                    if (!IsPhysicalPipeConnector(connector) || !connector.IsConnected) continue;

                    int referenceCount = 0;
                    foreach (Connector other in connector.AllRefs)
                    {
                        if (++referenceCount > MaxReferencesPerConnector || ++inspectedReferences > MaxConnectorReferences)
                            throw new InvalidOperationException("The pipe network exceeds the connector reference inspection budget. Request fewer hops.");
                        if (!IsPhysicalPipeConnector(other) || !other.IsConnected || !connector.IsConnectedTo(other) || !other.IsConnectedTo(connector)) continue;

                        Element owner = other.Owner;
                        if (owner == null || !doc.Equals(owner.Document) || owner.Id.Value <= 0)
                        {
                            boundaryReached = true;
                            continue;
                        }
                        long ownerId = owner.Id.Value;
                        if (ownerId == elementId) continue;

                        if (!depths.ContainsKey(ownerId))
                        {
                            if (hop == maxHops)
                            {
                                boundaryReached = true;
                                continue;
                            }
                            if (nodes.Count >= SchematicModelRules.MaxNodes)
                                throw new InvalidOperationException("The pipe network exceeds the node limit. Request fewer hops.");

                            string kind = PipeNetworkKind(owner);
                            depths.Add(ownerId, hop + 1);
                            nodes.Add(ownerId, PipeNetworkNode(owner, kind, hop + 1));
                            if (kind == "equipment_boundary") boundaryReached = true;
                            else queue.Enqueue(owner);
                        }

                        bool forward = elementId < ownerId;
                        long fromId = forward ? elementId : ownerId;
                        long toId = forward ? ownerId : elementId;
                        int fromConnector = forward ? connector.Id : other.Id;
                        int toConnector = forward ? other.Id : connector.Id;
                        if (fromConnector < 0 || toConnector < 0)
                            throw new InvalidOperationException("A physical piping connection has no usable connector identity.");
                        string edgeKey = String.Format(CultureInfo.InvariantCulture, "{0}:{1}:{2}:{3}", fromId, fromConnector, toId, toConnector);
                        if (edges.ContainsKey(edgeKey)) continue;
                        if (edges.Count >= SchematicModelRules.MaxEdges)
                            throw new InvalidOperationException("The pipe network exceeds the edge limit. Request fewer hops.");
                        edges.Add(edgeKey, new {
                            from_element_id = fromId.ToString(CultureInfo.InvariantCulture), from_connector_id = fromConnector,
                            to_element_id = toId.ToString(CultureInfo.InvariantCulture), to_connector_id = toConnector
                        });
                    }
                }
            }

            return new {
                schema_version = 1, root_element_id = rootId.ToString(CultureInfo.InvariantCulture), max_hops = maxHops,
                nodes = nodes.Values.ToArray(), edges = edges.Values.ToArray(), boundary_reached = boundaryReached
            };
        }

        private static bool IsPhysicalPipeConnector(Connector connector)
        {
            return connector != null && connector.Domain == Domain.DomainPiping &&
                (connector.ConnectorType == ConnectorType.End || connector.ConnectorType == ConnectorType.Curve || connector.ConnectorType == ConnectorType.Physical);
        }

        private static string PipeNetworkKind(Element element)
        {
            if (element is Pipe) return "pipe";
            long category = element.Category == null ? 0 : element.Category.Id.Value;
            if (category == (long)BuiltInCategory.OST_PipeFitting) return "fitting";
            if (category == (long)BuiltInCategory.OST_PipeAccessory)
            {
                var instance = element as FamilyInstance;
                var fitting = instance == null ? null : instance.MEPModel as MechanicalFitting;
                if (fitting != null && (fitting.PartType == PartType.ValveNormal || fitting.PartType == PartType.ValveBreaksInto)) return "valve";
                return "pipe_accessory";
            }
            return "equipment_boundary";
        }

        private static object PipeNetworkNode(Element element, string kind, int hop)
        {
            if (String.IsNullOrWhiteSpace(element.UniqueId))
                throw new InvalidOperationException("A pipe network element has no persistent identity.");
            var instance = element as FamilyInstance;
            FamilySymbol symbol = instance == null ? null : instance.Symbol;
            string family = symbol == null ? null : symbol.FamilyName;
            string name = String.IsNullOrWhiteSpace(element.Name) ? kind : element.Name;
            if (!String.IsNullOrWhiteSpace(family) && !String.Equals(family, name, StringComparison.Ordinal)) name = family + " · " + name;
            return new { id = NativeModelQueries.SignedId(element.Id), unique_id = element.UniqueId, name = Trim(name, 300), kind, hop };
        }

        public static object Preview(UIApplication app, Dictionary<string, object> args)
        {
            Document doc = RequireDocument(app);
            object input;
            if (args == null || !args.TryGetValue("start_element_id", out input))
                throw new InvalidOperationException("start_element_id is required.");
            long rootId = PositiveId(input);
            Element root = doc.GetElement(new ElementId(rootId));
            if (root == null || !Supported(root)) throw new InvalidOperationException("Select a pipe, duct, or MEP family instance for the schematic root.");
            string path = SavedPath(doc);
            string fingerprint = Fingerprint(doc);
            Domain domain = NetworkDomain(root);
            var model = new SchematicModel { documentPath = path, documentFingerprint = fingerprint,
                rootElementId = root.Id.Value, rootUniqueId = root.UniqueId };
            model.warnings.Add("Basic native symbols and breadth-first layout; this is not engineering system analysis.");
            var visited = new HashSet<long>();
            var ranks = new Dictionary<long, int>();
            var rankRows = new Dictionary<int, int>();
            var edgeKeys = new HashSet<string>(StringComparer.Ordinal);
            var queue = new Queue<Element>();
            int inspectedReferences = 0;
            visited.Add(rootId);
            ranks.Add(rootId, 0);
            queue.Enqueue(root);
            while (queue.Count > 0)
            {
                Element element = queue.Dequeue();
                int rank = ranks[element.Id.Value];
                int row;
                rankRows.TryGetValue(rank, out row);
                rankRows[rank] = row + 1;
                model.nodes.Add(Node(element, rank * 1500.0, row * 1000.0));
                foreach (Element neighbour in PhysicalNeighbours(element, domain, ref inspectedReferences).OrderBy(candidate => candidate.Id.Value))
                {
                    long neighbourId = neighbour.Id.Value;
                    if (!visited.Contains(neighbourId))
                    {
                        // Enforce the limit before retaining a new vertex, not after graph construction.
                        if (visited.Count >= SchematicModelRules.MaxNodes)
                            throw new InvalidOperationException("Connected network exceeds " + SchematicModelRules.MaxNodes + " elements; choose a smaller isolated network.");
                        visited.Add(neighbourId);
                        ranks.Add(neighbourId, rank + 1);
                        queue.Enqueue(neighbour);
                    }
                    string source = element.Id.Value.ToString(CultureInfo.InvariantCulture);
                    string target = neighbourId.ToString(CultureInfo.InvariantCulture);
                    string pair = String.CompareOrdinal(source, target) < 0 ? source + ":" + target : target + ":" + source;
                    if (edgeKeys.Add(pair))
                    {
                        if (model.edges.Count >= SchematicModelRules.MaxEdges)
                            throw new InvalidOperationException("Connected network exceeds " + SchematicModelRules.MaxEdges + " connections; choose a smaller isolated network.");
                        model.edges.Add(new SchematicEdge { source = source, target = target });
                    }
                }
            }
            if (model.edges.Count == 0) model.warnings.Add("No physical pipe or duct connections were found; the preview contains only the root.");
            SchematicModelRules.Validate(model);
            return model;
        }

        public static object Export(UIApplication app, Dictionary<string, object> args)
        {
            Document doc = RequireDocument(app);
            object drawing;
            if (args == null || !args.TryGetValue("drawing", out drawing) || !(drawing is Dictionary<string, object>))
                throw new InvalidOperationException("drawing must contain a schematic preview object.");
            SchematicModel model = SchematicModelRules.Parse(drawing);
            if (!String.Equals(Path.GetFullPath(model.documentPath), SavedPath(doc), StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(model.documentFingerprint, Fingerprint(doc), StringComparison.Ordinal))
                throw new InvalidOperationException("The preview belongs to a different document; refresh it in the intended saved sample.");
            Element root = doc.GetElement(new ElementId(model.rootElementId));
            if (root == null || root.UniqueId != model.rootUniqueId || !Supported(root))
                throw new InvalidOperationException("The preview root no longer matches the current model; refresh the preview.");
            foreach (SchematicNode node in model.nodes)
            {
                Element current = doc.GetElement(new ElementId(node.elementId));
                if (current == null || current.UniqueId != node.uniqueId || !Supported(current))
                    throw new InvalidOperationException("Preview element " + node.key + " changed or was removed; refresh the preview.");
            }
            // Editing positions or labels is allowed; silently exporting stale connectivity is not.
            SchematicModel fresh = (SchematicModel)Preview(app, new Dictionary<string, object> { { "start_element_id", model.rootElementId } });
            var currentNodes = new HashSet<string>(fresh.nodes.Select(node => node.key), StringComparer.Ordinal);
            var currentEdges = new HashSet<string>(fresh.edges.Select(EdgeKey), StringComparer.Ordinal);
            if (!currentNodes.SetEquals(model.nodes.Select(node => node.key)) || !currentEdges.SetEquals(model.edges.Select(EdgeKey)))
                throw new InvalidOperationException("The physical network changed after preview; refresh before exporting the edited layout.");
            var nodeMap = model.nodes.ToDictionary(node => node.key, StringComparer.Ordinal);
            foreach (SchematicEdge edge in model.edges)
            {
                SchematicNode source = nodeMap[edge.source];
                SchematicNode target = nodeMap[edge.target];
                double dx = source.x - target.x, dy = source.y - target.y;
                if (Math.Sqrt(dx * dx + dy * dy) * FeetPerMillimetre <= app.Application.ShortCurveTolerance)
                    throw new InvalidOperationException("Connected nodes overlap or are too close to export; move them apart in the editor.");
            }
            ViewFamilyType draftingType;
            TextNoteType existingTextType;
            using (var collector = new FilteredElementCollector(doc))
                draftingType = collector.OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>()
                    .Where(type => type.ViewFamily == ViewFamily.Drafting).OrderBy(type => type.Id.Value).FirstOrDefault();
            using (var collector = new FilteredElementCollector(doc))
                existingTextType = collector.OfClass(typeof(TextNoteType)).Cast<TextNoteType>().OrderBy(type => type.Id.Value).FirstOrDefault();
            if (draftingType == null) throw new InvalidOperationException("This document has no drafting view family type.");
            if (existingTextType == null) throw new InvalidOperationException("This document has no text note type to duplicate.");

            long viewId;
            string viewName;
            using (var transaction = new Transaction(doc, "BuildX: export schematic"))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start schematic transaction.");
                try
                {
                    ViewDrafting view = ViewDrafting.Create(doc, draftingType.Id);
                    view.Name = "BuildX 系统图 " + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) + " " + view.Id.Value.ToString(CultureInfo.InvariantCulture);
                    view.Scale = 50;
                    TextNoteType textType = (TextNoteType)existingTextType.Duplicate("BuildX Schematic 2.5mm " + view.Id.Value.ToString(CultureInfo.InvariantCulture));
                    Parameter size = textType.get_Parameter(BuiltInParameter.TEXT_SIZE);
                    if (size == null || size.IsReadOnly || size.StorageType != StorageType.Double)
                        throw new InvalidOperationException("The duplicated text type has no writable text-size parameter.");
                    double textSize = 2.5 * FeetPerMillimetre;
                    if (!size.Set(textSize) && Math.Abs(size.AsDouble() - textSize) > 1e-9)
                        throw new InvalidOperationException("Revit refused the schematic text size.");
                    foreach (SchematicEdge edge in model.edges)
                    {
                        XYZ a = Position(nodeMap[edge.source]);
                        XYZ b = Position(nodeMap[edge.target]);
                        doc.Create.NewDetailCurve(view, Line.CreateBound(a, b));
                    }
                    foreach (SchematicNode node in model.nodes)
                    {
                        XYZ centre = Position(node);
                        // Four native detail lines form an intentionally simple, editable symbol.
                        double halfWidth = 180 * FeetPerMillimetre, halfHeight = 120 * FeetPerMillimetre;
                        XYZ a = centre + new XYZ(-halfWidth, -halfHeight, 0);
                        XYZ b = centre + new XYZ(halfWidth, -halfHeight, 0);
                        XYZ c = centre + new XYZ(halfWidth, halfHeight, 0);
                        XYZ d = centre + new XYZ(-halfWidth, halfHeight, 0);
                        doc.Create.NewDetailCurve(view, Line.CreateBound(a, b));
                        doc.Create.NewDetailCurve(view, Line.CreateBound(b, c));
                        doc.Create.NewDetailCurve(view, Line.CreateBound(c, d));
                        doc.Create.NewDetailCurve(view, Line.CreateBound(d, a));
                        string label = String.IsNullOrWhiteSpace(node.label) ? node.key : node.label;
                        TextNote.Create(doc, view.Id, centre + new XYZ(250 * FeetPerMillimetre, 150 * FeetPerMillimetre, 0), label, textType.Id);
                    }
                    doc.Regenerate();
                    viewId = view.Id.Value;
                    viewName = view.Name;
                    VerifyDrawing(doc, viewId, model.nodes.Count, model.edges.Count);
                    transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions()
                        .SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true));
                    if (transaction.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("Revit rejected the schematic; the transaction was rolled back.");
                }
                catch
                {
                    if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack();
                    throw;
                }
            }
            // Re-read native objects after the inner commit; the host still owns rollback/commit.
            object counts = VerifyDrawing(doc, viewId, model.nodes.Count, model.edges.Count);
            using (var collector = new FilteredElementCollector(doc, new ElementId(viewId)))
            {
                Element[] actual = collector.WhereElementIsNotElementType()
                    .Where(element => element is DetailCurve || element is TextNote).OrderBy(element => element.Id.Value).ToArray();
                int curves = actual.Count(element => element is DetailCurve);
                int texts = actual.Count(element => element is TextNote);
                return new { view_id = viewId, view_name = viewName, element_ids = actual.Select(element => element.Id.Value).ToArray(),
                    actual_node_count = texts, edge_line_count = curves - texts * 4, text_count = texts, detail_curve_count = curves,
                    symbol_style = "basic-native-symbols", layout_note = "layout_bfs_not_engineering_analysis", verification = counts };
            }
        }

        private static object VerifyDrawing(Document doc, long viewId, int expectedNodes, int expectedEdges)
        {
            ViewDrafting view = doc.GetElement(new ElementId(viewId)) as ViewDrafting;
            if (view == null || view.Scale != 50) throw new InvalidOperationException("Created schematic drafting view could not be read back.");
            using (var collector = new FilteredElementCollector(doc, view.Id))
            {
                Element[] actual = collector.WhereElementIsNotElementType().ToArray();
                int curves = actual.Count(element => element is DetailCurve);
                int texts = actual.Count(element => element is TextNote);
                if (curves != expectedNodes * 4 + expectedEdges || texts != expectedNodes)
                    throw new InvalidOperationException("Schematic read-back counts do not match the required symbols, connections, and labels.");
                foreach (TextNote note in actual.OfType<TextNote>())
                {
                    TextNoteType type = doc.GetElement(note.GetTypeId()) as TextNoteType;
                    Parameter size = type == null ? null : type.get_Parameter(BuiltInParameter.TEXT_SIZE);
                    if (size == null || Math.Abs(size.AsDouble() - 2.5 * FeetPerMillimetre) > 1e-9)
                        throw new InvalidOperationException("Schematic text size did not survive native read-back.");
                }
                return new { verified_detail_curves = curves, verified_text_notes = texts, verified_view_scale = view.Scale };
            }
        }

        private static SchematicNode Node(Element element, double x, double y)
        {
            string category = element.Category == null ? "" : element.Category.Name ?? "";
            string label = (element.Name ?? "") + " [" + element.Id.Value.ToString(CultureInfo.InvariantCulture) + "]";
            Pipe pipe = element as Pipe;
            Duct duct = element as Duct;
            if (pipe != null || duct != null)
            {
                Parameter diameter = element.get_Parameter(pipe != null ? BuiltInParameter.RBS_PIPE_DIAMETER_PARAM : BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (diameter != null && diameter.StorageType == StorageType.Double && diameter.AsDouble() > 0)
                    label = (pipe != null ? "Pipe DN" : "Duct Ø") + (diameter.AsDouble() / FeetPerMillimetre).ToString("0.#", CultureInfo.InvariantCulture) + " [" + element.Id.Value.ToString(CultureInfo.InvariantCulture) + "]";
            }
            return new SchematicNode { key = element.Id.Value.ToString(CultureInfo.InvariantCulture), uniqueId = element.UniqueId,
                elementId = element.Id.Value, label = Trim(label, 300), category = Trim(category, 300), x = x, y = y };
        }

        private static IEnumerable<Element> PhysicalNeighbours(Element element, Domain domain, ref int inspectedReferences)
        {
            var neighbours = new Dictionary<long, Element>();
            foreach (Connector connector in Connectors(element))
            {
                if (!Physical(connector, domain) || !connector.IsConnected) continue;
                int referenceCount = 0;
                foreach (Connector other in connector.AllRefs)
                {
                    if (++referenceCount > MaxReferencesPerConnector) throw new InvalidOperationException("A connector has too many references; choose a smaller network.");
                    if (++inspectedReferences > MaxConnectorReferences) throw new InvalidOperationException("The network exceeds the connector-reference inspection budget; choose a smaller network.");
                    if (!Physical(other, domain) || !other.IsConnected || !connector.IsConnectedTo(other) || !other.IsConnectedTo(connector)) continue;
                    Element owner = other.Owner;
                    if (owner != null && owner.Id.Value != element.Id.Value && Supported(owner))
                    {
                        if (!neighbours.ContainsKey(owner.Id.Value) && neighbours.Count >= SchematicModelRules.MaxNodes)
                            throw new InvalidOperationException("The connected network exceeds the preview node limit; choose a smaller network.");
                        neighbours[owner.Id.Value] = owner;
                    }
                }
            }
            return neighbours.Values;
        }

        private static IEnumerable<Connector> Connectors(Element element)
        {
            ConnectorManager manager = null;
            Pipe pipe = element as Pipe;
            Duct duct = element as Duct;
            FamilyInstance family = element as FamilyInstance;
            if (pipe != null) manager = pipe.ConnectorManager;
            else if (duct != null) manager = duct.ConnectorManager;
            else if (family != null && family.MEPModel != null) manager = family.MEPModel.ConnectorManager;
            var result = new List<Connector>();
            if (manager == null) return result;
            foreach (Connector connector in manager.Connectors)
            {
                if (result.Count >= MaxConnectorsPerElement) throw new InvalidOperationException("An element has too many connectors for this preview.");
                result.Add(connector);
            }
            return result;
        }

        private static bool Physical(Connector connector, Domain domain)
        {
            return connector != null && connector.ConnectorType != ConnectorType.Logical && connector.Domain == domain;
        }

        private static Domain NetworkDomain(Element root)
        {
            if (root is Pipe) return Domain.DomainPiping;
            if (root is Duct) return Domain.DomainHvac;
            Domain[] domains = Connectors(root).Where(connector => connector.ConnectorType != ConnectorType.Logical)
                .Select(connector => connector.Domain).Where(domain => domain == Domain.DomainPiping || domain == Domain.DomainHvac).Distinct().ToArray();
            if (domains.Length != 1) throw new InvalidOperationException("The root must have one pipe or duct connector domain; select a pipe or duct beside mixed-domain equipment.");
            return domains[0];
        }

        private static bool Supported(Element element)
        {
            FamilyInstance family = element as FamilyInstance;
            return element is Pipe || element is Duct || (family != null && family.MEPModel != null);
        }

        private static Document RequireDocument(UIApplication app)
        {
            if (app == null || app.ActiveUIDocument == null) throw new InvalidOperationException("Open the saved sample document first.");
            Document doc = app.ActiveUIDocument.Document;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Schematics require a project document.");
            return doc;
        }

        private static string SavedPath(Document doc)
        {
            if (String.IsNullOrWhiteSpace(doc.PathName)) throw new InvalidOperationException("Save the sample document before creating a schematic preview.");
            return Path.GetFullPath(doc.PathName);
        }

        private static string Fingerprint(Document doc)
        {
            ProjectInfo information = doc.ProjectInformation;
            if (information == null || String.IsNullOrWhiteSpace(information.UniqueId)) throw new InvalidOperationException("The document has no persistent project identity.");
            return information.UniqueId;
        }

        private static long PositiveId(object value)
        {
            if (!(value is int) && !(value is long) && !(value is decimal) && !(value is double)) throw new InvalidOperationException("start_element_id must be an integer.");
            decimal number;
            try { number = Convert.ToDecimal(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new InvalidOperationException("start_element_id must be a finite integer."); }
            if (number < 1 || number > 9007199254740991L || Decimal.Truncate(number) != number)
                throw new InvalidOperationException("start_element_id is outside the supported integer range.");
            return (long)number;
        }

        private static XYZ Position(SchematicNode node) { return new XYZ(node.x * FeetPerMillimetre, -node.y * FeetPerMillimetre, 0); }
        private static string Trim(string value, int maximum) { return value.Length <= maximum ? value : value.Substring(0, maximum); }
        private static string EdgeKey(SchematicEdge edge)
        {
            return String.CompareOrdinal(edge.source, edge.target) < 0 ? edge.source + ":" + edge.target : edge.target + ":" + edge.source;
        }

        private sealed class RejectErrors : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
                    if (failure.GetSeverity() == FailureSeverity.Error || failure.GetSeverity() == FailureSeverity.DocumentCorruption)
                        return FailureProcessingResult.ProceedWithRollBack;
                return FailureProcessingResult.Continue;
            }
        }
    }
}

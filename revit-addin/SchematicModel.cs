using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    // BuildX's own interchange format. Coordinates are schematic millimetres,
    // never Revit model coordinates; no live Revit objects cross this boundary.
    internal sealed class SchematicModel
    {
        public int schemaVersion = 1;
        public string documentPath;
        public string documentFingerprint;
        public long rootElementId;
        public string rootUniqueId;
        public List<SchematicNode> nodes = new List<SchematicNode>();
        public List<SchematicEdge> edges = new List<SchematicEdge>();
        public List<string> warnings = new List<string>();
    }

    internal sealed class SchematicNode
    {
        public string key;
        public string uniqueId;
        public string label;
        public string category;
        public long elementId;
        public double x;
        public double y;
    }

    internal sealed class SchematicEdge
    {
        public string source;
        public string target;
    }

    internal static class SchematicModelRules
    {
        public const int MaxNodes = 300;
        public const int MaxEdges = 800;
        private const long MaxJsonInteger = 9007199254740991L;

        public static SchematicModel Parse(object value)
        {
            var drawing = value as Dictionary<string, object>;
            ExactFields(drawing, "schemaVersion", "documentPath", "documentFingerprint", "rootElementId", "rootUniqueId", "nodes", "edges", "warnings");
            if (PositiveId(drawing["schemaVersion"], "schemaVersion") != 1) throw new InvalidOperationException("Unsupported schematic schemaVersion.");
            PositiveId(drawing["rootElementId"], "rootElementId");
            IList nodes = drawing["nodes"] as IList;
            IList edges = drawing["edges"] as IList;
            IList warnings = drawing["warnings"] as IList;
            if (nodes == null || nodes.Count < 1 || nodes.Count > MaxNodes || edges == null || edges.Count > MaxEdges || warnings == null || warnings.Count > 100)
                throw new InvalidOperationException("Invalid or oversized schematic arrays.");
            foreach (object input in nodes)
            {
                var node = input as Dictionary<string, object>;
                ExactFields(node, "key", "uniqueId", "label", "category", "elementId", "x", "y");
                PositiveId(node["elementId"], "elementId");
                RequireNumericCoordinate(node["x"]);
                RequireNumericCoordinate(node["y"]);
                RequireString(node["key"]);
                RequireString(node["uniqueId"]);
                RequireString(node["label"]);
                RequireString(node["category"]);
            }
            foreach (object input in edges)
            {
                var edge = input as Dictionary<string, object>;
                ExactFields(edge, "source", "target");
                RequireString(edge["source"]);
                RequireString(edge["target"]);
            }
            foreach (object warning in warnings) RequireString(warning);
            RequireString(drawing["documentPath"]);
            RequireString(drawing["documentFingerprint"]);
            RequireString(drawing["rootUniqueId"]);
            var serializer = new JavaScriptSerializer { MaxJsonLength = 250000, RecursionLimit = 32 };
            SchematicModel model = serializer.Deserialize<SchematicModel>(serializer.Serialize(drawing));
            Validate(model);
            return model;
        }

        public static void Validate(SchematicModel model)
        {
            if (model == null || model.schemaVersion != 1)
                throw new InvalidOperationException("Unsupported or missing schematic schemaVersion; expected 1.");
            if (String.IsNullOrWhiteSpace(model.documentPath) || model.documentPath.Length > 32768 || !Path.IsPathRooted(model.documentPath))
                throw new InvalidOperationException("Schematic requires an absolute saved-document path.");
            if (String.IsNullOrWhiteSpace(model.documentFingerprint) || model.documentFingerprint.Length > 512)
                throw new InvalidOperationException("Schematic requires a persistent document fingerprint.");
            if (model.rootElementId <= 0 || model.rootElementId > MaxJsonInteger || String.IsNullOrWhiteSpace(model.rootUniqueId) || model.rootUniqueId.Length > 512)
                throw new InvalidOperationException("Schematic requires an exact root element identity.");
            if (model.nodes == null || model.nodes.Count < 1 || model.nodes.Count > MaxNodes)
                throw new InvalidOperationException("Schematic node count must be between 1 and " + MaxNodes + ".");
            if (model.edges == null || model.edges.Count > MaxEdges)
                throw new InvalidOperationException("Schematic edge count must not exceed " + MaxEdges + ".");
            if (model.warnings == null || model.warnings.Count > 100)
                throw new InvalidOperationException("Schematic warnings must be an array of at most 100 messages.");
            foreach (string warning in model.warnings)
                if (warning == null || warning.Length > 1000) throw new InvalidOperationException("Invalid schematic warning.");

            var identities = new HashSet<string>(StringComparer.Ordinal);
            var uniqueIds = new HashSet<string>(StringComparer.Ordinal);
            bool rootFound = false;
            foreach (SchematicNode node in model.nodes)
            {
                if (node == null || node.elementId <= 0 || node.elementId > MaxJsonInteger ||
                    node.key != node.elementId.ToString(CultureInfo.InvariantCulture) || !identities.Add(node.key))
                    throw new InvalidOperationException("Schematic nodes require distinct element-id keys.");
                if (String.IsNullOrWhiteSpace(node.uniqueId) || node.uniqueId.Length > 512 || !uniqueIds.Add(node.uniqueId))
                    throw new InvalidOperationException("Schematic nodes require distinct persistent element identities.");
                if (node.label == null || node.label.Length > 300 || node.category == null || node.category.Length > 300)
                    throw new InvalidOperationException("Schematic labels and categories must be at most 300 characters.");
                if (!FiniteCoordinate(node.x) || !FiniteCoordinate(node.y))
                    throw new InvalidOperationException("Schematic coordinates must be finite and within +/- 1000000 mm.");
                if (node.elementId == model.rootElementId)
                {
                    if (node.uniqueId != model.rootUniqueId) throw new InvalidOperationException("Schematic root identity does not match its node.");
                    rootFound = true;
                }
            }
            if (!rootFound) throw new InvalidOperationException("Schematic root must occur in the node list.");
            var edges = new HashSet<string>(StringComparer.Ordinal);
            foreach (SchematicEdge edge in model.edges)
            {
                if (edge == null || edge.source == null || edge.target == null || edge.source == edge.target ||
                    !identities.Contains(edge.source) || !identities.Contains(edge.target))
                    throw new InvalidOperationException("Schematic edges require two different existing node keys.");
                string pair = String.CompareOrdinal(edge.source, edge.target) < 0 ? edge.source + ":" + edge.target : edge.target + ":" + edge.source;
                if (!edges.Add(pair)) throw new InvalidOperationException("Duplicate undirected schematic edge.");
            }
        }

        private static bool FiniteCoordinate(double value)
        {
            return !Double.IsNaN(value) && !Double.IsInfinity(value) && Math.Abs(value) <= 1000000;
        }

        private static void ExactFields(Dictionary<string, object> value, params string[] expected)
        {
            if (value == null || value.Count != expected.Length || expected.Any(key => !value.ContainsKey(key)))
                throw new InvalidOperationException("Schematic object has missing or unsupported fields.");
        }

        private static void RequireString(object value)
        {
            if (!(value is string)) throw new InvalidOperationException("Schematic text fields must be strings.");
        }

        private static void RequireNumericCoordinate(object value)
        {
            if (!(value is int) && !(value is long) && !(value is decimal) && !(value is double))
                throw new InvalidOperationException("Schematic coordinates must be JSON numbers.");
            if (!FiniteCoordinate(Convert.ToDouble(value, CultureInfo.InvariantCulture)))
                throw new InvalidOperationException("Schematic coordinate exceeds the supported range.");
        }

        private static long PositiveId(object value, string field)
        {
            if (!(value is int) && !(value is long) && !(value is decimal) && !(value is double))
                throw new InvalidOperationException(field + " must be an integer.");
            decimal number;
            try { number = Convert.ToDecimal(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new InvalidOperationException(field + " must be a finite integer."); }
            if (number < 1 || number > MaxJsonInteger || Decimal.Truncate(number) != number)
                throw new InvalidOperationException(field + " is outside the supported integer range.");
            return (long)number;
        }
    }
}

param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
$artifacts = (Join-Path $root 'artifacts') + [IO.Path]::DirectorySeparatorChar
if (-not $evidence.StartsWith($artifacts, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $evidence)) {
    throw 'Choose a new evidence directory under the source tree artifacts directory.'
}
[IO.Directory]::CreateDirectory($evidence) | Out-Null

# Compile the production read methods verbatim. The fixture models only the API surface used by the reader.
$source = [IO.File]::ReadAllText((Join-Path $root 'revit-addin/SchematicRevitService.cs'))
function Read-SourcePart([string]$start, [string]$end) {
    $begin = $source.IndexOf($start, [StringComparison]::Ordinal)
    if ($begin -lt 0) { throw "Missing source boundary $start" }
    $finish = $source.IndexOf($end, $begin + $start.Length, [StringComparison]::Ordinal)
    if ($finish -lt 0) { throw "Missing source boundary $end" }
    $source.Substring($begin, $finish - $begin)
}
$readMethods = Read-SourcePart '        private const int MaxConnectorsPerElement' '        public static object Preview('
$connectors = Read-SourcePart '        private static IEnumerable<Connector> Connectors(' '        private static bool Physical('
$trim = Read-SourcePart '        private static string Trim(' '        private static string EdgeKey('
$program = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    enum Domain { DomainPiping, DomainHvac }
    enum ConnectorType { End, Curve, Physical, Logical }
    enum BuiltInCategory { OST_PipeFitting = -1, OST_PipeAccessory = -2 }
    enum PartType { Normal, ValveNormal, ValveBreaksInto }

    class ElementId { public long Value; public ElementId(long value) { Value = value; } }
    class Category { public ElementId Id; }
    class Document
    {
        public bool IsFamilyDocument { get { return false; } }
        public readonly Dictionary<long, Element> Elements = new Dictionary<long, Element>();
        public Element GetElement(ElementId id) { return Elements.ContainsKey(id.Value) ? Elements[id.Value] : null; }
    }
    class Element { public ElementId Id; public Document Document; public Category Category; public string UniqueId; public string Name; }
    class Connector
    {
        public int Id;
        public Domain Domain;
        public ConnectorType ConnectorType;
        public Element Owner;
        public readonly List<Connector> AllRefs = new List<Connector>();
        public readonly HashSet<Connector> PhysicalPeers = new HashSet<Connector>();
        public bool IsConnected { get { if (ConnectorType == ConnectorType.Logical) throw new InvalidOperationException("Logical API access"); return PhysicalPeers.Count > 0; } }
        public bool IsConnectedTo(Connector other) { return PhysicalPeers.Contains(other); }
    }
    class ConnectorManager { public readonly List<Connector> Connectors = new List<Connector>(); }
    class Pipe : Element { public readonly ConnectorManager ConnectorManager = new ConnectorManager(); }
    class Duct : Element { public readonly ConnectorManager ConnectorManager = new ConnectorManager(); }
    class MEPModel { public readonly ConnectorManager ConnectorManager = new ConnectorManager(); }
    class MechanicalFitting : MEPModel { public PartType PartType; }
    class FamilySymbol { public string FamilyName; }
    class FamilyInstance : Element { public MEPModel MEPModel; public FamilySymbol Symbol; }
    static class SchematicModelRules { internal const int MaxNodes = 300; internal const int MaxEdges = 800; }
    static class NativeModelQueries
    {
        internal static long ExactId(Dictionary<string, object> args, string key) { return Convert.ToInt64(args[key], CultureInfo.InvariantCulture); }
        internal static string SignedId(ElementId id) { return id.Value.ToString(CultureInfo.InvariantCulture); }
    }
    static class SchematicRevitService
    {
/* READ_METHODS */
/* CONNECTORS */
/* TRIM */
    }

    static class PipeNetworkCheck
    {
        const long PumpId = 9007199254740993L;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static int assertions;

        static void Main(string[] outputFiles)
        {
            var doc = new Document();
            var pump = Add(doc, new FamilyInstance { MEPModel = new MEPModel() }, PumpId, "Pump");
            var pipe = Add(doc, new Pipe(), 21, "Pipe");
            var valve = Add(doc, new FamilyInstance { MEPModel = new MechanicalFitting { PartType = PartType.ValveNormal }, Symbol = new FamilySymbol { FamilyName = "Gate valve" } }, 22, "DN100", BuiltInCategory.OST_PipeAccessory);
            var accessory = Add(doc, new FamilyInstance { MEPModel = new MechanicalFitting() }, 23, "Name says valve", BuiltInCategory.OST_PipeAccessory);
            var equipment = Add(doc, new FamilyInstance { MEPModel = new MEPModel() }, 24, "Other equipment");
            var beyond = Add(doc, new Pipe(), 25, "Beyond equipment");
            var nearby = Add(doc, new Pipe(), 26, "Nearby without connection");
            var fitting = Add(doc, new FamilyInstance { MEPModel = new MechanicalFitting() }, 27, "Elbow", BuiltInCategory.OST_PipeFitting);
            Link(Port(pump, 1), Port(pipe, 1));
            Link(Port(pump, 2), Port(pipe, 2));
            Link(Port(pipe, 3), Port(valve, 1));
            Link(Port(valve, 2), Port(accessory, 1));
            Link(Port(accessory, 2), Port(equipment, 1));
            Link(Port(equipment, 2), Port(beyond, 1));
            Port(pump, 1, ConnectorType.Logical).AllRefs.Add(Port(nearby, 2));
            Port(pump, 3, ConnectorType.End, Domain.DomainHvac);
            Link(Port(pump, 4), Port(fitting, 1));

            string captured = Json.Serialize(Read(doc));
            var data = Json.Deserialize<Dictionary<string, object>>(captured);
            var nodes = Rows(data, "nodes").ToDictionary(row => (string)row["id"]);
            var edges = Rows(data, "edges").ToList();
            Check(nodes.Count == 6 && !nodes.ContainsKey("25") && !nodes.ContainsKey("26"), "Only physically connected in-scope nodes are returned.");
            Check((string)data["root_element_id"] == PumpId.ToString(CultureInfo.InvariantCulture), "Exact 64-bit root ID survives.");
            Check((string)nodes["22"]["kind"] == "valve" && (int)nodes["22"]["hop"] == 2 && ((string)nodes["22"]["name"]).Contains("Gate valve"), "A native ValveNormal subtype is identified and has a readable family name.");
            Check((string)nodes["23"]["kind"] == "pipe_accessory", "A display name cannot establish valve type.");
            Check((string)nodes["24"]["kind"] == "equipment_boundary" && (bool)data["boundary_reached"], "Traversal stops at other equipment.");
            Check((string)nodes["27"]["kind"] == "fitting" && (int)nodes["27"]["hop"] == 1, "The root's separate branch is retained.");
            Check(edges.Count == 6 && edges.Where(edge => (string)edge["from_element_id"] == "21" && (string)edge["to_element_id"] == (string)data["root_element_id"]).Select(edge => (int)edge["to_connector_id"]).OrderBy(id => id).SequenceEqual(new[] { 1, 2 }), "Reverse traversal deduplicates edges and keeps parallel port pairs.");
            Check(captured == Json.Serialize(Read(doc)), "Repeated reads produce identical output.");
            var shortRead = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(Read(doc, 1)));
            Check(Rows(shortRead, "nodes").Count() == 3 && (bool)shortRead["boundary_reached"], "Hop cutoff exposes an incomplete boundary.");

            var star = new Document();
            var starRoot = Add(star, new FamilyInstance { MEPModel = new MEPModel() }, PumpId, "Pump");
            for (int i = 1; i <= 300; i++) Link(Port(starRoot, i), Port(Add(star, new Pipe(), i, "Pipe"), 1));
            CheckThrows(() => Read(star), "node limit");
            var parallel = new Document();
            var parallelRoot = Add(parallel, new FamilyInstance { MEPModel = new MEPModel() }, PumpId, "Pump");
            var parallelPipe = Add(parallel, new Pipe(), 1, "Pipe");
            for (int i = 1; i <= 801; i++) Link(Port(parallelRoot, i), Port(parallelPipe, i));
            CheckThrows(() => Read(parallel), "edge limit");
            System.IO.File.WriteAllText(outputFiles[0], captured);
            Console.WriteLine("Controlled production pipe network checks: " + assertions + "/" + assertions);
        }

        static object Read(Document doc, int? hops = null)
        {
            var args = new Dictionary<string, object> { { "start_element_id", PumpId.ToString(CultureInfo.InvariantCulture) } };
            if (hops.HasValue) args["max_hops"] = hops.Value;
            return SchematicRevitService.ReadPipeNetwork(doc, args);
        }
        static IEnumerable<Dictionary<string, object>> Rows(Dictionary<string, object> result, string field)
        { return ((System.Collections.ArrayList)result[field]).Cast<Dictionary<string, object>>(); }
        static T Add<T>(Document doc, T element, long id, string name, BuiltInCategory? category = null) where T : Element
        {
            element.Id = new ElementId(id); element.Document = doc; element.Name = name; element.UniqueId = "unique-" + id;
            if (category.HasValue) element.Category = new Category { Id = new ElementId((long)category.Value) };
            doc.Elements.Add(id, element);
            return element;
        }
        static Connector Port(Element owner, int id, ConnectorType kind = ConnectorType.End, Domain domain = Domain.DomainPiping)
        {
            var connector = new Connector { Owner = owner, Id = id, ConnectorType = kind, Domain = domain };
            (owner is Pipe ? ((Pipe)owner).ConnectorManager : ((FamilyInstance)owner).MEPModel.ConnectorManager).Connectors.Add(connector);
            return connector;
        }
        static void Link(Connector left, Connector right)
        { left.AllRefs.Add(right); right.AllRefs.Add(left); left.PhysicalPeers.Add(right); right.PhysicalPeers.Add(left); }
        static void Check(bool okay, string label) { if (!okay) throw new Exception(label); assertions++; }
        static void CheckThrows(Func<object> run, string message)
        {
            try { run(); }
            catch (InvalidOperationException e) { Check(e.Message.Contains(message), e.Message); return; }
            throw new Exception("Expected rejection: " + message);
        }
    }
}
'@
$fixturePath = Join-Path $evidence 'pipe-network-peers.generated.cs'
[IO.File]::WriteAllText($fixturePath, $program.Replace('/* READ_METHODS */', $readMethods).Replace('/* CONNECTORS */', $connectors).Replace('/* TRIM */', $trim), [Text.UTF8Encoding]::new($false))
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$exe = Join-Path $evidence 'check-pipe-network.exe'
& (Join-Path $framework 'csc.exe') /nologo /target:exe /platform:x64 /langversion:5 /codepage:65001 /utf8output ('/out:' + $exe) ('/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')) $fixturePath 2>&1 |
    Tee-Object -FilePath (Join-Path $evidence 'compile.log')
if ($LASTEXITCODE -ne 0) { throw 'The controlled pipe network compilation failed.' }
$resultPath = Join-Path $evidence 'result.json'
& $exe $resultPath | Tee-Object -FilePath (Join-Path $evidence 'results.txt')
if ($LASTEXITCODE -ne 0) { throw 'The controlled pipe network checks failed.' }
$validation = @'
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [resultPath, contractPath] = process.argv.slice(1);
const {PIPE_NETWORK_QUERY_NAME, assertNativeModelQueryResult} = await import(pathToFileURL(contractPath));
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
assertNativeModelQueryResult(PIPE_NETWORK_QUERY_NAME, result, {start_element_id: '9007199254740993'});
console.log('Production Node result contract: 1/1');
'@
& node --input-type=module -e $validation $resultPath (Join-Path $root 'lib/native-model-queries.mjs') |
    Tee-Object -FilePath (Join-Path $evidence 'result-contract.txt')
if ($LASTEXITCODE -ne 0) { throw 'The controlled C# pipe network result failed the BuildX contract.' }

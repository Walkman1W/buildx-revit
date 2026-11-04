using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    internal sealed class CadQueryException : InvalidOperationException
    {
        public readonly string Code;
        public CadQueryException(string code, string message) : base(BoundedMessage(message)) { Code = code; }
        private static string BoundedMessage(string message)
        {
            if (message == null || message.Length <= 4096) return message;
            return message.Substring(0, 4096) + " [diagnostic truncated to keep the error response bounded]";
        }
    }

    // Owns the wire arguments for both CAD reads. No conversion from display strings or floats.
    internal sealed class CadQueryArguments
    {
        public string ExpectedDocument;
        public string NameContains = "";
        public int Offset;
        public int Limit = 20;
        public string ExpectedSnapshot;
        public long ImportElementId;

        public static CadQueryArguments Parse(string operation, Dictionary<string, object> args)
        {
            bool listing = operation == "list_cad_imports";
            if (!listing && operation != "read_cad_geometry") throw Error("CAD_UNKNOWN_OPERATION", "Unknown CAD read operation.");
            if (args == null) throw Error("CAD_ARGUMENTS_REQUIRED", "CAD arguments are required.");
            var allowed = new HashSet<string>(new[] { "expected_document", "offset", "limit", "expected_snapshot", listing ? "name_contains" : "import_element_id" }, StringComparer.Ordinal);
            foreach (string key in args.Keys) if (!allowed.Contains(key)) throw Error("CAD_UNKNOWN_ARGUMENT", "Unknown CAD argument: " + key);
            var query = new CadQueryArguments();
            object value;
            if (!args.TryGetValue("expected_document", out value) || !(value is string)) throw Error("CAD_DOCUMENT_REQUIRED", "expected_document must be a saved absolute Windows document path.");
            query.ExpectedDocument = (string)value;
            RequireSavedDocumentPath(query.ExpectedDocument);
            if (args.TryGetValue("offset", out value)) query.Offset = Integer(value, "offset", 0, Int32.MaxValue);
            if (args.TryGetValue("limit", out value)) query.Limit = Integer(value, "limit", 1, 50);
            if (args.TryGetValue("expected_snapshot", out value))
            {
                if (!(value is string) || !Regex.IsMatch((string)value, "\\A[0-9a-f]{64}\\z")) throw Error("CAD_SNAPSHOT_INVALID", "expected_snapshot must be a lowercase SHA-256 identifier.");
                query.ExpectedSnapshot = (string)value;
            }
            if (query.Offset > 0 && query.ExpectedSnapshot == null) throw Error("CAD_SNAPSHOT_REQUIRED", "Pages after offset 0 require expected_snapshot from the preceding page.");
            if (listing)
            {
                if (args.TryGetValue("name_contains", out value))
                {
                    if (!(value is string) || ((string)value).Length > 200) throw Error("CAD_FILTER_INVALID", "name_contains must be a string of at most 200 characters.");
                    query.NameContains = (string)value;
                }
            }
            else
            {
                if (!args.TryGetValue("import_element_id", out value)) throw Error("CAD_IMPORT_ID_REQUIRED", "import_element_id is required.");
                query.ImportElementId = ImportId(value);
            }
            return query;
        }

        public static void RequireSavedDocumentPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path) || path.Length > 32767 || path.IndexOf('\0') >= 0 ||
                path.StartsWith("\\\\?\\", StringComparison.Ordinal) || path.StartsWith("\\\\.\\", StringComparison.Ordinal))
                throw Error("CAD_DOCUMENT_PATH_INVALID", "CAD reads require a saved drive-rooted or complete UNC path; device and relative paths are rejected.");
            bool drive = Regex.IsMatch(path, "\\A[A-Za-z]:[\\\\/].+");
            bool unc = Regex.IsMatch(path, "\\A\\\\\\\\[^\\\\/]+\\\\[^\\\\/]+\\\\.+");
            if (!drive && !unc) throw Error("CAD_DOCUMENT_PATH_INVALID", "CAD reads require a saved drive-rooted or complete UNC path; root-relative and drive-relative paths are rejected.");
            try { Path.GetFullPath(path); }
            catch (Exception error)
            {
                if (!(error is ArgumentException) && !(error is NotSupportedException) && !(error is PathTooLongException)) throw;
                throw Error("CAD_DOCUMENT_PATH_INVALID", "Invalid saved document path: " + error.Message);
            }
        }

        private static int Integer(object value, string name, int minimum, int maximum)
        {
            long integer = ExactNumericInteger(value, name);
            if (integer < minimum || integer > maximum) throw Error("CAD_INTEGER_RANGE", name + " is outside its permitted integer range.");
            return (int)integer;
        }
        internal static long ImportId(object value)
        {
            string text = value as string;
            long id;
            if (text != null)
            {
                if (!Regex.IsMatch(text, "\\A[1-9][0-9]*\\z") || !Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out id))
                    throw Error("CAD_IMPORT_ID_INVALID", "import_element_id must be a positive decimal Int64 string without signs, leading zeros or whitespace.");
            }
            else id = ExactNumericInteger(value, "import_element_id");
            if (id <= 0) throw Error("CAD_IMPORT_ID_INVALID", "import_element_id must be positive.");
            return id;
        }
        private static long ExactNumericInteger(object value, string name)
        {
            if (!(value is byte) && !(value is sbyte) && !(value is short) && !(value is ushort) && !(value is int) && !(value is uint) && !(value is long) && !(value is ulong))
                throw Error("CAD_INTEGER_REQUIRED", name + " must be an exact JSON integer; floating-point, decimal and boolean values are rejected.");
            decimal integer = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            if (integer < -9007199254740991m || integer > 9007199254740991m)
                throw Error("CAD_UNSAFE_NUMERIC_ID", name + " exceeds the safe JSON integer range; use a decimal string for a native element id.");
            return (long)integer;
        }
        private static CadQueryException Error(string code, string message) { return new CadQueryException(code, message); }
    }

    internal sealed class CadImportItem
    {
        public string elementId;
        public string uniqueId;
        public string name;
        public bool isLinked;
    }
    internal sealed class CadImportCoverage
    {
        public bool? enumerationComplete;
        public int examinedImports;
        public int maxImports = 5000;
    }
    internal sealed class CadImportSnapshot
    {
        public string documentPath;
        public string documentFingerprint;
        public string nameContains;
        public List<CadImportItem> items = new List<CadImportItem>();
        public List<CadIssue> warnings = new List<CadIssue>();
        public CadImportCoverage coverage;
    }

    // Pure DTO wire producer. Paging, ID serialization, snapshot and UTF-8 budgets have one owner.
    internal static class CadGeometryPaging
    {
        public const int MaxResponseBytes = 64 * 1024;
        public const int MaxSnapshotBytes = 32 * 1024 * 1024;
        private static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxSnapshotBytes, RecursionLimit = 40 }; }

        public static object ReadPage(CadReadResult read, CadQueryArguments query, Func<object, object> envelope, string requestId)
        {
            if (read == null) throw new CadQueryException("CAD_NATIVE_RESULT_MISSING", "The native reader returned no result.");
            if (!read.ok && read.value == null)
                throw new CadQueryException("CAD_NATIVE_READ_FAILED", DescribeError(read.error));
            CadGeometryInventory inventory = read.value;
            if (inventory == null || inventory.source == null || inventory.units == null || inventory.coverage == null || inventory.entities == null || inventory.warnings == null)
                throw new CadQueryException("CAD_COVERAGE_UNKNOWN", "Native geometry metadata or coverage is missing; completeness cannot be inferred.");
            object source = WireSource(inventory.source);
            var warnings = new List<CadIssue>(inventory.warnings);
            if (!read.ok) warnings.Add(new CadIssue { code = "NATIVE_READ_FAILED", message = DescribeError(read.error), path = read.error == null ? null : read.error.path });
            object coverage = WireCoverage(inventory.coverage, read.ok);
            string snapshot;
            using (var hash = new SnapshotHash())
            {
                hash.Add("kind", "BuildX-CAD-read-v1");
                hash.Add("schemaVersion", inventory.schemaVersion);
                hash.Add("source", source); hash.Add("units", inventory.units);
                for (int index = 0; index < inventory.entities.Count; index++) hash.Add("entity", WireEntity(inventory.entities[index], index));
                hash.Add("warnings", warnings); hash.Add("coverage", coverage);
                snapshot = hash.Finish();
            }
            bool complete = read.ok && inventory.coverage.enumerationComplete;
            return Page(query, inventory.entities.Count, complete, snapshot,
                index => WireEntity(inventory.entities[index], index),
                (rows, page) => new { inventory.schemaVersion, source, inventory.units, warnings, coverage, entities = rows, page }, envelope, requestId);
        }

        public static object ImportPage(CadImportSnapshot snapshot, CadQueryArguments query, Func<object, object> envelope, string requestId)
        {
            if (snapshot == null || snapshot.items == null || snapshot.warnings == null || snapshot.coverage == null || !snapshot.coverage.enumerationComplete.HasValue)
                throw new CadQueryException("CAD_COVERAGE_UNKNOWN", "Import enumeration coverage is unknown.");
            string id;
            using (var hash = new SnapshotHash())
            {
                hash.Add("kind", "BuildX-CAD-import-list-v1");
                hash.Add("identity", new { snapshot.documentPath, snapshot.documentFingerprint, snapshot.nameContains });
                foreach (CadImportItem item in snapshot.items) hash.Add("item", item);
                hash.Add("warnings", snapshot.warnings);
                hash.Add("coverage", snapshot.coverage);
                id = hash.Finish();
            }
            return Page(query, snapshot.items.Count, snapshot.coverage.enumerationComplete.Value, id,
                index => snapshot.items[index],
                (rows, page) => new { snapshot.documentPath, snapshot.documentFingerprint, items = rows, snapshot.warnings, page, snapshot.coverage }, envelope, requestId);
        }

        public static void RecordImportFailure(CadImportSnapshot snapshot, Exception error, string path)
        {
            if (snapshot == null || snapshot.coverage == null || snapshot.warnings == null)
                throw new CadQueryException("CAD_IMPORT_SOURCE_INVALID", "A valid import-list source is required before a partial failure can be retained.");
            snapshot.coverage.enumerationComplete = false;
            if (snapshot.warnings.Count < 100)
                snapshot.warnings.Add(new CadIssue { code = "NATIVE_IMPORT_LIST_FAILED",
                    message = error == null ? "Native import-list read failed without an exception record." : error.GetType().FullName + ": " + error.Message, path = path });
            else if (snapshot.warnings.Count == 100)
                snapshot.warnings.Add(new CadIssue { code = "DIAGNOSTICS_LIMIT", message = "Further native import-list diagnostics omitted; enumeration remains incomplete.", path = path });
        }

        private static object Page(CadQueryArguments query, int total, bool complete, string snapshot, Func<int, object> item,
            Func<object[], object, object> value, Func<object, object> envelope, string requestId)
        {
            if (query == null || envelope == null) throw new CadQueryException("CAD_PAGE_ARGUMENTS_INVALID", "Page arguments and envelope factory are required.");
            if (query.ExpectedSnapshot != null && !String.Equals(query.ExpectedSnapshot, snapshot, StringComparison.Ordinal))
                throw new CadQueryException("CAD_SNAPSHOT_CHANGED", "模型/CAD已变更，请从offset 0刷新；previous pages must not be combined with this read.");
            if (query.Offset < 0 || query.Offset > total || (total > 0 && query.Offset == total) || query.Limit < 1 || query.Limit > 50)
                throw new CadQueryException("CAD_PAGE_RANGE", "offset is outside the retained inventory or limit is outside 1..50.");
            int maximum = Math.Min(query.Limit, total - query.Offset);
            var rows = new List<object>();
            Func<object[], object> wrap = selected =>
            {
                int? next = query.Offset + selected.Length < total ? (int?)(query.Offset + selected.Length) : null;
                var page = new { offset = query.Offset, limit = query.Limit, returned = selected.Length, totalRetainedEntities = total,
                    nextOffset = next, snapshotId = snapshot, enumerationComplete = complete };
                return envelope(value(selected, page));
            };
            Func<object, bool> fits = wrapped =>
            {
                // Measure the actual queue response shape, not UTF-16 length or the page alone.
                object transport = new { id = requestId, ok = true, result = wrapped, completedUtc = "0001-01-01T00:00:00.0000000Z" };
                return Utf8Length(transport) <= MaxResponseBytes;
            };
            object accepted = wrap(rows.ToArray());
            if (!fits(accepted)) throw new CadQueryException("CAD_METADATA_TOO_LARGE", "CAD metadata cannot fit the 64 KiB UTF-8 response budget.");
            for (int index = 0; index < maximum; index++)
            {
                object nextRow = item(query.Offset + index);
                // A page is grown within its byte budget. Never serialize fifty oversized
                // rows as a batch merely to discover that the requested page cannot fit.
                if (Utf8Length(nextRow) > MaxResponseBytes)
                {
                    if (rows.Count == 0) throw new CadQueryException("CAD_ENTITY_TOO_LARGE", "One CAD entity cannot fit the 64 KiB UTF-8 response budget; no empty progress page was returned.");
                    break;
                }
                rows.Add(nextRow);
                object candidate = wrap(rows.ToArray());
                if (!fits(candidate))
                {
                    rows.RemoveAt(rows.Count - 1);
                    if (rows.Count == 0) throw new CadQueryException("CAD_ENTITY_TOO_LARGE", "One CAD entity plus metadata cannot fit the 64 KiB UTF-8 response budget; no empty progress page was returned.");
                    break;
                }
                accepted = candidate;
            }
            return accepted;
        }

        public static int Utf8Length(object value) { return Encoding.UTF8.GetByteCount(Serializer().Serialize(value)); }
        private static object WireSource(CadImportSource source)
        {
            return new { source.format, source.documentPath, source.documentFingerprint,
                importElementId = source.importElementId.ToString(CultureInfo.InvariantCulture), source.importUniqueId, source.importTypeName,
                source.isLinked, source.originalCadPath, source.originalCadUnits, source.geometryCoordinateSpace,
                source.geometryInstanceTransformsApplied, source.importTotalTransformMetadata };
        }
        private static object WireCoverage(CadCoverage source, bool nativeReadOk)
        {
            return new { source.examinedObjectCount, source.retainedEntityCount, source.lineSegmentCount, source.unsupportedEntityCount,
                source.invalidLineCount, source.maxObservedDepth, enumerationComplete = nativeReadOk && source.enumerationComplete,
                interpretationComplete = nativeReadOk && source.interpretationComplete, stopReason = nativeReadOk ? source.stopReason : "NATIVE_READ_FAILED",
                source.maxObjects, source.maxSegments, source.maxDepth, source.maxRetainedEntities };
        }
        private static object WireEntity(CadPrimitive entity, int index)
        {
            if (entity == null || entity.ordinal != index + 1) throw new CadQueryException("CAD_ORDINAL_INVALID", "Native inventory ordinals must remain globally contiguous.");
            return new { entity.ordinal, entity.type, entity.geometryPath, entity.segmentIndex, entity.layer,
                graphicsStyleId = entity.graphicsStyleId.HasValue ? entity.graphicsStyleId.Value.ToString(CultureInfo.InvariantCulture) : null,
                entity.localFrom, entity.localTo, entity.modelFromInternal, entity.modelToInternal, entity.modelFromMm, entity.modelToMm,
                entity.cumulativeTransform, entity.issues };
        }
        private static string DescribeError(CadReadError error)
        {
            return error == null ? "Native read failed without an error record." : "code=" + error.code + "; path=" + error.path + "; message=" + error.message;
        }

        // Hash one bounded DTO chunk at a time. This is an inventory snapshot, not a CAD-file digest.
        private sealed class SnapshotHash : IDisposable
        {
            private readonly SHA256 hash = SHA256.Create();
            private int totalBytes;
            public void Add(string tag, object value)
            {
                string serialized = Serializer().Serialize(value);
                int count = Encoding.UTF8.GetByteCount(serialized);
                byte[] tagBytes = Encoding.ASCII.GetBytes(tag);
                if ((long)totalBytes + count + tagBytes.Length + 8 > MaxSnapshotBytes)
                    throw new CadQueryException("CAD_SNAPSHOT_TOO_LARGE", "Inventory snapshot exceeds the 32 MiB UTF-8 hash budget; no whole-inventory serialization was attempted.");
                byte[] bytes = Encoding.UTF8.GetBytes(serialized);
                Feed(BitConverter.GetBytes(tagBytes.Length)); Feed(tagBytes); Feed(BitConverter.GetBytes(bytes.Length)); Feed(bytes);
            }
            private void Feed(byte[] bytes) { hash.TransformBlock(bytes, 0, bytes.Length, bytes, 0); totalBytes += bytes.Length; }
            public string Finish()
            {
                hash.TransformFinalBlock(new byte[0], 0, 0);
                return BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
            }
            public void Dispose() { hash.Dispose(); }
        }
    }
}

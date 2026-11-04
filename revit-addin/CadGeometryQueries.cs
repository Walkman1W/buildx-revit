using System;
using System.Collections.Generic;
using System.Globalization;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Revit API context only. Read branches never enter sample checks or transactions.
    internal static class CadGeometryQueries
    {
        public static bool IsRead(string operation) { return operation == "list_cad_imports" || operation == "read_cad_geometry"; }

        public static object Read(Document document, string operation, CadQueryArguments query, Func<object, object> envelope, string requestId)
        {
            if (document == null) throw new CadQueryException("CAD_DOCUMENT_REQUIRED", "Open the exact saved Revit document first.");
            CadQueryArguments.RequireSavedDocumentPath(document.PathName);
            if (operation == "list_cad_imports") return CadGeometryPaging.ImportPage(ListImports(document, query.NameContains), query, envelope, requestId);
            if (operation != "read_cad_geometry") throw new CadQueryException("CAD_UNKNOWN_OPERATION", "Unknown CAD read operation.");
            ImportInstance import = document.GetElement(new ElementId(query.ImportElementId)) as ImportInstance;
            if (import == null) throw new CadQueryException("CAD_IMPORT_NOT_FOUND", "import_element_id does not identify an ImportInstance in the exact active document.");
            return CadGeometryPaging.ReadPage(CadGeometryReader.Read(document, import), query, envelope, requestId);
        }

        private static CadImportSnapshot ListImports(Document document, string filter)
        {
            var result = new CadImportSnapshot { documentPath = document.PathName,
                nameContains = filter, coverage = new CadImportCoverage { enumerationComplete = true } };
            // Without the saved document source a partial list would have no useful identity.
            CadQueryArguments.RequireSavedDocumentPath(result.documentPath);
            try
            {
                result.documentFingerprint = document.ProjectInformation == null ? null : document.ProjectInformation.UniqueId;
                if (String.IsNullOrEmpty(result.documentFingerprint))
                    CadGeometryPaging.RecordImportFailure(result, new InvalidOperationException("ProjectInformation.UniqueId is unknown; no replacement identity was inferred."), "source/documentFingerprint");
            }
            catch (Exception error)
            {
                if (Fatal(error)) throw;
                CadGeometryPaging.RecordImportFailure(result, error, "source/documentFingerprint");
            }
            try
            {
                using (var collector = new FilteredElementCollector(document).OfClass(typeof(ImportInstance)).WhereElementIsNotElementType())
                using (IEnumerator<Element> iterator = collector.GetEnumerator())
                {
                    while (true)
                    {
                        string path = "imports[" + result.coverage.examinedImports.ToString(CultureInfo.InvariantCulture) + "]";
                        bool next;
                        try { next = iterator.MoveNext(); }
                        catch (Exception error)
                        {
                            if (Fatal(error)) throw;
                            CadGeometryPaging.RecordImportFailure(result, error, path + "/MoveNext");
                            break;
                        }
                        if (!next) break;
                        // One lookahead proves that more imports exist; no metadata is read from it.
                        if (result.coverage.examinedImports >= result.coverage.maxImports)
                        { result.coverage.enumerationComplete = false; break; }
                        result.coverage.examinedImports++;
                        try
                        {
                            var import = iterator.Current as ImportInstance;
                            if (import == null) throw new CadQueryException("CAD_IMPORT_ENUMERATION_INVALID", "The ImportInstance collector yielded an unexpected element.");
                            long id = import.Id.Value;
                            string uniqueId = import.UniqueId;
                            string name = import.Name;
                            bool linked = import.IsLinked;
                            if (id <= 0 || String.IsNullOrEmpty(uniqueId) || name == null)
                                throw new CadQueryException("CAD_IMPORT_IDENTITY_UNKNOWN", "Import identity or display name is unknown; no item was invented.");
                            if (!String.IsNullOrEmpty(filter) && name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                            result.items.Add(new CadImportItem { elementId = id.ToString(CultureInfo.InvariantCulture), uniqueId = uniqueId, name = name, isLinked = linked });
                        }
                        catch (Exception error)
                        {
                            if (Fatal(error)) throw;
                            CadGeometryPaging.RecordImportFailure(result, error, path + "/metadata");
                        }
                    }
                }
            }
            catch (Exception error)
            {
                if (Fatal(error)) throw;
                // Preserve already known items when collector creation/disposal fails too.
                CadGeometryPaging.RecordImportFailure(result, error, "imports/enumerator");
            }
            result.items.Sort((left, right) => Int64.Parse(left.elementId, CultureInfo.InvariantCulture).CompareTo(Int64.Parse(right.elementId, CultureInfo.InvariantCulture)));
            return result;
        }

        private static bool Fatal(Exception error)
        {
            return error is OutOfMemoryException || error is StackOverflowException || error is System.Threading.ThreadAbortException || error is AccessViolationException;
        }
    }
}

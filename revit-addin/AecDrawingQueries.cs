using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // BuildX implementation using public Revit API. AEC terminology describes revision instances.
    internal static class AecDrawingQueries
    {
        internal static bool IsRead(string operation)
        {
            return operation == "get_revision_sequences" || operation == "get_schedule_data" || operation == "preview_dwg_export" || operation == "preview_nwc_export" || operation == "preview_ifc_export";
        }

        internal static object Read(Document doc, string operation, Dictionary<string, object> args)
        {
            if (doc == null) throw new InvalidOperationException("Open a Revit document before this query.");
            if (operation == "preview_ifc_export")
            {
                NativeModelQueries.Fields(args, "expected_document", "view_id");
                if (doc.IsFamilyDocument || doc.IsLinked) throw new InvalidOperationException("IFC preview requires a non-linked project document.");
                long id = NativeModelQueries.ExactId(args, "view_id");
                var view = doc.GetElement(new ElementId(id)) as View;
                string status = view == null ? "missing_or_not_view" : view.IsTemplate ? "template" : "non_template_view";
                return new { schema_version = 1, view_id = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    view_status = status, exporter_available = OptionalFunctionalityUtils.IsIFCAvailable(), document_read_only = doc.IsReadOnly };
            }
            if (operation == "preview_nwc_export")
            {
                NativeModelQueries.Fields(args, "expected_document", "view_id");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("NWC preview requires a project document.");
                long id = NativeModelQueries.ExactId(args, "view_id");
                var view = doc.GetElement(new ElementId(id)) as View3D;
                string status = view == null ? "missing_or_not_3d_view" : view.IsTemplate ? "template" :
                    !view.CanBePrinted ? "not_printable" : "printable_3d";
                return new { schema_version = 1, view_id = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    view_status = status, exporter_available = OptionalFunctionalityUtils.IsNavisworksExporterAvailable() };
            }
            if (operation == "preview_dwg_export")
            {
                NativeModelQueries.Fields(args, "expected_document", "view_id", "setup_name");
                if (doc.IsFamilyDocument) throw new InvalidOperationException("DWG preview requires a project document.");
                long id = NativeModelQueries.ExactId(args, "view_id");
                string setupName = null;
                bool? setupFound = null;
                if (args.ContainsKey("setup_name"))
                {
                    setupName = args["setup_name"] as string;
                    if (setupName == null || setupName.Length < 1 || setupName.Length > 255 ||
                        setupName.Trim() != setupName || String.IsNullOrWhiteSpace(setupName) ||
                        setupName[0] == '\ufeff' || setupName[setupName.Length - 1] == '\ufeff' ||
                        setupName.Any(c => c < 0x20 || (c >= 0x7f && c <= 0x9f)))
                        throw new InvalidOperationException("setup_name must be a valid exact setup name.");
                    setupFound = BaseExportOptions.GetPredefinedSetupNames(doc).Any(name => String.Equals(name, setupName, StringComparison.Ordinal));
                }
                var view = doc.GetElement(new ElementId(id)) as View;
                string status = view == null ? "missing_or_not_view" : view.IsTemplate ? "template" :
                    ((view is ViewSheet && ((ViewSheet)view).IsPlaceholder) || !view.CanBePrinted) ? "not_printable" : "printable";
                return new { schema_version = 1, view_id = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    view_status = status, exporter_available = OptionalFunctionalityUtils.IsDWGExportAvailable(),
                    setup_name = setupName, setup_found = setupFound };
            }
            var budget = new NativeModelQueries.ReadBudget();
            if (operation == "get_revision_sequences")
            {
                NativeModelQueries.Fields(args, "expected_document", "offset", "limit");
                int offset = NativeModelQueries.Page(args, "offset", 0, 0, Int32.MaxValue);
                int limit = NativeModelQueries.Page(args, "limit", 100, 1, 200);
                var revisions = new List<Revision>();
                using (var collector = new FilteredElementCollector(doc).OfClass(typeof(Revision)))
                    foreach (Revision revision in collector) { budget.Scan(); revisions.Add(revision); }
                var items = new List<object>();
                foreach (Revision revision in revisions.OrderBy(r => r.SequenceNumber).ThenBy(r => r.Id.Value).Skip(offset).Take(limit))
                {
                    object item = new { id = NativeModelQueries.SignedId(revision.Id), name = revision.Name,
                        date = revision.RevisionDate, description = revision.Description, sequence = revision.SequenceNumber, issued = revision.Issued };
                    budget.Reserve(item);
                    items.Add(item);
                }
                var coverage = new { scanned = budget.Scanned, complete = true, stop_reason = (string)null };
                budget.Reserve(coverage);
                return new { schema_version = 1, items = items.ToArray(), offset, limit, total = revisions.Count,
                    has_more = (long)offset + items.Count < revisions.Count, coverage };
            }
            if (operation == "get_schedule_data")
            {
                NativeModelQueries.Fields(args, "expected_document", "schedule_id", "row_offset", "row_limit", "column_offset", "column_limit");
                long id = NativeModelQueries.ExactId(args, "schedule_id");
                int offset = NativeModelQueries.Page(args, "row_offset", 0, 0, Int32.MaxValue);
                int limit = NativeModelQueries.Page(args, "row_limit", 50, 1, 100);
                int columnOffset = NativeModelQueries.Page(args, "column_offset", 0, 0, Int32.MaxValue);
                int columnLimit = NativeModelQueries.Page(args, "column_limit", 20, 1, 100);
                var schedule = doc.GetElement(new ElementId(id)) as ViewSchedule;
                if (schedule == null) throw new InvalidOperationException("schedule_id must identify a schedule in the current document.");
                TableData table = schedule.GetTableData();
                TableSectionData body = table.GetSectionData(SectionType.Body);
                int rows = body.NumberOfRows, columns = body.NumberOfColumns;
                if (rows < 0 || columns < 0) throw new InvalidOperationException("Schedule body has invalid dimensions.");
                int pageRows = Math.Min(limit, Math.Max(0, rows - offset));
                int pageColumns = Math.Min(columnLimit, Math.Max(0, columns - columnOffset));
                if ((long)pageRows * pageColumns > 2000) throw new InvalidOperationException("Schedule page exceeds 2000 cells; request a smaller row_limit.");
                var resultRows = new List<object>();
                for (int i = 0; i < pageRows; i++)
                {
                    int rowIndex = checked(body.FirstRowNumber + offset + i);
                    var cells = new List<object>();
                    for (int j = 0; j < pageColumns; j++)
                    {
                        budget.Scan();
                        int columnIndex = checked(body.FirstColumnNumber + columnOffset + j);
                        object cell = new { column_index = columnIndex, text = schedule.GetCellText(SectionType.Body, rowIndex, columnIndex) };
                        budget.Reserve(cell);
                        cells.Add(cell);
                    }
                    resultRows.Add(new { row_index = rowIndex, cells = cells.ToArray() });
                }
                var coverage = new { scanned = budget.Scanned, complete = true, stop_reason = (string)null };
                budget.Reserve(new { schedule_name = schedule.Name, coverage });
                return new { schema_version = 1, schedule_id = NativeModelQueries.SignedId(schedule.Id), schedule_name = schedule.Name,
                    section = "body", first_row = body.FirstRowNumber, first_column = body.FirstColumnNumber,
                    row_count = rows, column_count = columns, row_offset = offset, row_limit = limit,
                    column_offset = columnOffset, column_limit = columnLimit, has_more_columns = (long)columnOffset + pageColumns < columns,
                    has_more = (long)offset + pageRows < rows, rows = resultRows.ToArray(), coverage };
            }
            throw new InvalidOperationException("Unknown drawing query.");
        }
    }
}

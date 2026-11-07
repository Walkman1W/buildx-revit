using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class SheetRenumberExpectation
        {
            internal long Id; internal string UniqueId, Before, After, Temporary;
        }
        private static List<SheetRenumberExpectation> RenumberSheets(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "sheets");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Sheet renumbering requires a project document.");
            IList items = RequiredList(args, "sheets", 1, 50);
            var ids = new HashSet<long>(); var stableIds = new HashSet<string>(StringComparer.Ordinal); var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var rows = new List<SheetRenumberExpectation>();
            foreach (object raw in items)
            {
                var item = raw as Dictionary<string, object>;
                if (item == null) throw new InvalidOperationException("Each sheet entry must be an object.");
                Fields(item, "sheet_id", "expected_number", "new_number");
                long id = NativeModelQueries.ExactId(item, "sheet_id");
                string before = SheetText(item, "expected_number"), after = SheetText(item, "new_number");
                if (!ids.Add(id) || !targets.Add(after)) throw new InvalidOperationException("Duplicate sheet ID or target number.");
                ViewSheet sheet = RequiredElement(doc, id) as ViewSheet;
                if (sheet == null || !sheet.IsValidObject || String.IsNullOrWhiteSpace(sheet.UniqueId) || !stableIds.Add(sheet.UniqueId) || !String.Equals(sheet.SheetNumber, before, StringComparison.Ordinal))
                    throw new InvalidOperationException("Sheet identity or expected number does not match.");
                rows.Add(new SheetRenumberExpectation { Id = id, UniqueId = sheet.UniqueId, Before = before, After = after });
            }
            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var collector = new FilteredElementCollector(doc))
                foreach (ViewSheet sheet in collector.OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                {
                    if (!sheet.IsValidObject || String.IsNullOrEmpty(sheet.SheetNumber) || !used.Add(sheet.SheetNumber))
                        throw new InvalidOperationException("Global sheet numbers are unavailable or ambiguous.");
                    if (!ids.Contains(sheet.Id.Value) && targets.Contains(sheet.SheetNumber)) throw new InvalidOperationException("A target number belongs to another sheet.");
                }
            // Reserve every target as well as every current number before creating any temporary number.
            used.UnionWith(targets);
            foreach (SheetRenumberExpectation row in rows)
            {
                if (String.Equals(row.Before, row.After, StringComparison.Ordinal)) continue;
                string temporary = null;
                for (int attempt = 0; attempt < 10; attempt++)
                {
                    string candidate = "BX_TMP_" + Guid.NewGuid().ToString("N");
                    if (used.Add(candidate)) { temporary = candidate; break; }
                }
                if (temporary == null) throw new InvalidOperationException("Could not reserve unique temporary sheet number.");
                row.Temporary = temporary;
            }
            foreach (SheetRenumberExpectation row in rows)
            {
                ViewSheet sheet = doc.GetElement(new ElementId(row.Id)) as ViewSheet;
                if (sheet == null || !sheet.IsValidObject || sheet.UniqueId != row.UniqueId || sheet.SheetNumber != row.Before)
                    throw new InvalidOperationException("Sheet changed during preflight.");
                if (row.Temporary != null) sheet.SheetNumber = row.Temporary;
            }
            foreach (SheetRenumberExpectation row in rows)
            {
                ViewSheet sheet = doc.GetElement(new ElementId(row.Id)) as ViewSheet;
                if (sheet == null || !sheet.IsValidObject || sheet.UniqueId != row.UniqueId || sheet.SheetNumber != (row.Temporary ?? row.Before))
                    throw new InvalidOperationException("Sheet changed during temporary numbering.");
                if (row.Temporary != null) sheet.SheetNumber = row.After;
            }
            return rows;
        }
        private static object VerifyRenumberSheets(Document doc, List<SheetRenumberExpectation> rows)
        {
            var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (var collector = new FilteredElementCollector(doc))
                foreach (ViewSheet sheet in collector.OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
                    if (!sheet.IsValidObject || String.IsNullOrEmpty(sheet.SheetNumber) || !used.Add(sheet.SheetNumber))
                        throw new InvalidOperationException("Global sheet numbers are unavailable or ambiguous after renumbering.");
            var results = new List<object>();
            foreach (SheetRenumberExpectation row in rows)
            {
                ViewSheet sheet = doc.GetElement(new ElementId(row.Id)) as ViewSheet;
                if (sheet == null || !sheet.IsValidObject || sheet.UniqueId != row.UniqueId || sheet.SheetNumber != row.After)
                    throw new InvalidOperationException("Sheet identity or target number changed after renumbering.");
                results.Add(new { sheet_id = DescribedId(sheet.Id), unique_id = sheet.UniqueId, expected_number = row.Before, new_number = sheet.SheetNumber });
            }
            return new { count = results.Count, sheets = results.ToArray() };
        }

    }
}

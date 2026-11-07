using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class SheetDuplicationExpectation { internal ElementId Source, Target, TitleblockType; internal string SourceUnique, TargetUnique, SourceName, SourceNumber; }
        private static ElementId SingleSheetTitleblock(Document doc, ElementId sheet)
        {
            using (var collector = new FilteredElementCollector(doc).OwnedByView(sheet).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType())
            {
                var blocks = collector.ToElements();
                if (blocks.Count != 1 || blocks[0] == null || !blocks[0].IsValidObject || blocks[0].GetTypeId() == null || blocks[0].GetTypeId().Value <= 0) throw new InvalidOperationException("Sheet must own exactly one identifiable title block.");
                return blocks[0].GetTypeId();
            }
        }
        private static int SheetSchedules(Document doc, ElementId sheet)
        {
            using (var collector = new FilteredElementCollector(doc).OwnedByView(sheet).OfClass(typeof(ScheduleSheetInstance))) return collector.ToElements().Count;
        }
        private static SheetDuplicationExpectation DuplicateEmptySheet(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "source_sheet_id", "name", "number", "copy_option");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Sheet duplication requires a project document.");
            string name = SheetText(args, "name"), number = SheetText(args, "number");
            if (!String.Equals(Required(args, "copy_option") as string, "empty", StringComparison.Ordinal)) throw new InvalidOperationException("Only the empty copy option is supported.");
            ViewSheet source = RequiredElement(doc, NativeModelQueries.ExactId(args, "source_sheet_id")) as ViewSheet;
            if (source == null || !source.IsValidObject || source.IsPlaceholder || source.IsTemplate || String.IsNullOrEmpty(source.UniqueId)) throw new InvalidOperationException("Source must be a valid regular sheet.");
            ElementId titleblock = SingleSheetTitleblock(doc, source.Id);
            if (!source.CanBeDuplicated(SheetDuplicateOption.DuplicateEmptySheet)) throw new InvalidOperationException("Revit does not allow empty duplication for this sheet.");
            var expected = new SheetDuplicationExpectation { Source=source.Id, SourceUnique=source.UniqueId, SourceName=source.Name, SourceNumber=source.SheetNumber, TitleblockType=titleblock };
            ElementId id = source.Duplicate(SheetDuplicateOption.DuplicateEmptySheet);
            ViewSheet target = doc.GetElement(id) as ViewSheet;
            if (target == null || !target.IsValidObject || id.Value == source.Id.Value || String.IsNullOrEmpty(target.UniqueId) || target.UniqueId == source.UniqueId) throw new InvalidOperationException("Duplicate sheet did not produce a distinct identity.");
            target.SheetNumber = number; target.Name = name; expected.Target=id; expected.TargetUnique=target.UniqueId;
            doc.Regenerate(); VerifyDuplicatedSheet(doc,args,expected); return expected;
        }
        private static object VerifyDuplicatedSheet(Document doc, Dictionary<string, object> args, SheetDuplicationExpectation expected)
        {
            ViewSheet source=doc.GetElement(expected.Source) as ViewSheet, target=doc.GetElement(expected.Target) as ViewSheet;
            if (source == null || !source.IsValidObject || source.UniqueId != expected.SourceUnique || source.Name != expected.SourceName || source.SheetNumber != expected.SourceNumber || source.IsPlaceholder
                || SingleSheetTitleblock(doc,source.Id).Value != expected.TitleblockType.Value) throw new InvalidOperationException("Source sheet identity, properties or title block changed.");
            if (target == null || !target.IsValidObject || target.IsPlaceholder || target.IsTemplate || target.UniqueId != expected.TargetUnique
                || target.Name != SheetText(args,"name") || target.SheetNumber != SheetText(args,"number") || SingleSheetTitleblock(doc,target.Id).Value != expected.TitleblockType.Value)
                throw new InvalidOperationException("Duplicate sheet identity, name, number or title block changed.");
            if (target.GetAllViewports().Count != 0 || target.GetAllPlacedViews().Count != 0 || SheetSchedules(doc,target.Id) != 0) throw new InvalidOperationException("Empty duplicate unexpectedly contains placed viewports, views or schedules.");
            return new { element_id=DescribedId(target.Id), source_sheet_id=DescribedId(source.Id), name=target.Name, number=target.SheetNumber,
                copy_option="empty", titleblock_type_id=DescribedId(expected.TitleblockType), viewport_count=0, placed_view_count=0, schedule_count=0 };
        }
    }
}

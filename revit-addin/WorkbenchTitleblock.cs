using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class TitleblockWriteExpectation { internal ElementId Sheet, Block; internal string SheetUnique, BlockUnique; }
        private static TitleblockWriteExpectation PrepareTitleblockWrite(Document doc, Dictionary<string, object> args)
        {
            Fields(args,"expected_document","mode","sheet_id","titleblock_id","changes");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Title block writes require a project document.");
            long sheetId=NativeModelQueries.ExactId(args,"sheet_id"), blockId=NativeModelQueries.ExactId(args,"titleblock_id");
            ViewSheet sheet=RequiredElement(doc,sheetId) as ViewSheet;
            FamilyInstance block=RequiredElement(doc,blockId) as FamilyInstance;
            if (sheet==null || !sheet.IsValidObject || sheet.IsPlaceholder || sheet.IsTemplate || String.IsNullOrEmpty(sheet.UniqueId)
                || block==null || !block.IsValidObject || block.Category==null || block.Category.Id.Value!=(long)BuiltInCategory.OST_TitleBlocks
                || block.OwnerViewId==null || block.OwnerViewId.Value!=sheetId || String.IsNullOrEmpty(block.UniqueId)) throw new InvalidOperationException("Expected a regular sheet and its exact title block instance.");
            var expected=new TitleblockWriteExpectation { Sheet=sheet.Id, Block=block.Id, SheetUnique=sheet.UniqueId, BlockUnique=block.UniqueId };
            VerifyTitleblockOwner(doc, expected);
            IList changes=RequiredList(args,"changes",1,5); var seen=new HashSet<long>();
            foreach(object item in changes)
            {
                var change=item as Dictionary<string,object>; if(change==null) throw new InvalidOperationException("Invalid change.");
                Fields(change,"element_id","parameter_id","value","value_unit","expected_state");
                long elementId=NativeModelQueries.ExactId(change,"element_id"), parameterId=NativeModelQueries.ExactSignedId(change,"parameter_id");
                if(elementId!=blockId || parameterId==0 || parameterId==-1 || !seen.Add(parameterId)) throw new InvalidOperationException("Each parameter must be unique and belong to the selected title block.");
                Element owner; Parameter parameter=ResolveInstanceParameter(doc,elementId,parameterId,out owner); object before=InternalValue(parameter); string dataType;
                ValidateParameterBefore(parameter,change,before,out dataType); NormalizeParameterValue(parameter,Required(change,"value"),"value",true);
                string unit=OptionalString(change,"value_unit","");
                if(change.ContainsKey("value_unit") && unit!="internal" || parameter.StorageType==StorageType.Double && unit!="internal") throw new InvalidOperationException("Double parameters require internal unit.");
            }
            return expected;
        }
        private static void VerifyTitleblockOwner(Document doc, TitleblockWriteExpectation expected)
        {
            ViewSheet sheet=doc.GetElement(expected.Sheet) as ViewSheet; FamilyInstance block=doc.GetElement(expected.Block) as FamilyInstance;
            if(sheet==null || !sheet.IsValidObject || sheet.IsPlaceholder || sheet.UniqueId!=expected.SheetUnique || block==null || !block.IsValidObject || block.Category==null || block.Category.Id.Value!=(long)BuiltInCategory.OST_TitleBlocks || block.UniqueId!=expected.BlockUnique || block.OwnerViewId==null || block.OwnerViewId.Value!=expected.Sheet.Value)
                throw new InvalidOperationException("Title block or sheet identity changed.");
            using(var collector=new FilteredElementCollector(doc).OwnedByView(expected.Sheet).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsNotElementType())
            {
                var blocks=collector.ToElements(); if(blocks.Count!=1 || blocks[0].Id.Value!=expected.Block.Value) throw new InvalidOperationException("Sheet must have exactly one selected title block instance.");
            }
        }
        private static object WriteTitleblockParameters(Document doc, Dictionary<string,object> args, TitleblockWriteExpectation expected, List<ParameterWriteExpectation> writes)
        {
            var results=new List<object>(); foreach(object change in RequiredList(args,"changes",1,5))
            {
                var inner=new Dictionary<string,object> { { "changes",new object[]{change} } };
                results.Add(SetParameters(doc,inner,writes,true));
            }
            return new { element_id=DescribedId(expected.Block), sheet_id=DescribedId(expected.Sheet), results=results.ToArray() };
        }
    }
}

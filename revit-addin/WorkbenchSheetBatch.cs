using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex {
 internal static partial class WorkbenchActions {
  private sealed class SheetBatchExpectation { internal ElementId Id; internal string UniqueId; internal Dictionary<string,object> Args; }
  private static List<SheetBatchExpectation> CreateSheetBatch(UIApplication uiapp, Dictionary<string,object> args) {
   Fields(args,"expected_document","mode","sheets"); Document doc=uiapp.ActiveUIDocument.Document;
   if(doc.IsFamilyDocument)throw new InvalidOperationException("Sheets require a project document.");
   IList input=RequiredList(args,"sheets",1,50);var targets=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var items=new List<Dictionary<string,object>>();
   foreach(object raw in input){var item=raw as Dictionary<string,object>;if(item==null)throw new InvalidOperationException("Each sheet row must be an object.");
    Fields(item,"name","number","titleblock_id");SheetText(item,"name");string number=SheetText(item,"number");if(!targets.Add(number))throw new InvalidOperationException("Duplicate target sheet number.");
    if(item.ContainsKey("titleblock_id")){FamilySymbol symbol=RequiredElement(doc,NativeModelQueries.ExactId(item,"titleblock_id")) as FamilySymbol;if(symbol==null||!symbol.IsValidObject||symbol.Category==null||symbol.Category.Id.Value!=(long)BuiltInCategory.OST_TitleBlocks)throw new InvalidOperationException("titleblock_id must identify a valid title block type.");}
    items.Add(new Dictionary<string,object>(item,StringComparer.Ordinal));
   }
   var existing=new HashSet<string>(StringComparer.OrdinalIgnoreCase);using(var collector=new FilteredElementCollector(doc))foreach(ViewSheet sheet in collector.OfClass(typeof(ViewSheet)).Cast<ViewSheet>())
    if(!sheet.IsValidObject||String.IsNullOrEmpty(sheet.SheetNumber)||!existing.Add(sheet.SheetNumber)||targets.Contains(sheet.SheetNumber))throw new InvalidOperationException("Existing sheet numbers are invalid, ambiguous, or conflict with a target.");
   var result=new List<SheetBatchExpectation>();var ids=new HashSet<long>();var uids=new HashSet<string>(StringComparer.Ordinal);
   foreach(var item in items){var created=new BasicCreatedExpectation();BasicWrite(uiapp,"create_sheet",item,created);ViewSheet sheet=created.Id==null?null:doc.GetElement(created.Id) as ViewSheet;
    if(sheet==null||!sheet.IsValidObject||String.IsNullOrWhiteSpace(sheet.UniqueId)||!ids.Add(sheet.Id.Value)||!uids.Add(sheet.UniqueId))throw new InvalidOperationException("Created sheet identity is unavailable or duplicated.");
    result.Add(new SheetBatchExpectation{Id=sheet.Id,UniqueId=sheet.UniqueId,Args=item});
   }return result;
  }
  private static object VerifySheetBatch(Document doc,List<SheetBatchExpectation> rows){
   var results=new List<object>();foreach(var row in rows){ViewSheet sheet=doc.GetElement(row.Id) as ViewSheet;
    if(sheet==null||!sheet.IsValidObject||sheet.UniqueId!=row.UniqueId)throw new InvalidOperationException("Created sheet identity changed.");
    ReadBasicCreated(doc,"create_sheet",row.Args,row.Id);bool placeholder=!row.Args.ContainsKey("titleblock_id");ElementId type=placeholder?null:new ElementId(NativeModelQueries.ExactId(row.Args,"titleblock_id"));
    results.Add(new{element_id=DescribedId(sheet.Id),unique_id=sheet.UniqueId,name=sheet.Name,number=sheet.SheetNumber,is_placeholder=sheet.IsPlaceholder,titleblock_id=DescribedId(type)});
   }return new{count=results.Count,sheets=results.ToArray()};
  }
 }
}

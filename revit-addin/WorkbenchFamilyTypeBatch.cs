using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private static List<TypeChangeExpectation> ReplaceFamilyTypes(Document doc, Dictionary<string, object> args)
        {
            Fields(args,"expected_document","mode","element_ids","old_type_id","new_type_id");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Family type changes require a project document.");
            long oldId=NativeModelQueries.ExactId(args,"old_type_id"), newId=NativeModelQueries.ExactId(args,"new_type_id");
            if(oldId==newId) throw new InvalidOperationException("Old and new family types must differ.");
            FamilySymbol oldType=RequiredElement(doc,oldId) as FamilySymbol, newType=RequiredElement(doc,newId) as FamilySymbol;
            if(oldType==null || newType==null || !oldType.IsValidObject || !newType.IsValidObject || oldType.Document!=doc || newType.Document!=doc) throw new InvalidOperationException("Both type IDs must identify current-document FamilySymbols.");
            IList input=RequiredList(args,"element_ids",1,50); var seen=new HashSet<long>(); var expected=new List<TypeChangeExpectation>();
            foreach(object raw in input)
            {
                long id=NativeModelQueries.ExactId(new Dictionary<string,object>{{"id",raw}},"id");
                if(!seen.Add(id)) throw new InvalidOperationException("Duplicate instance ID.");
                FamilyInstance instance=RequiredElement(doc,id) as FamilyInstance;
                if(instance==null || !instance.IsValidObject || instance.Document!=doc || instance.GroupId==null || instance.GroupId.Value!=ElementId.InvalidElementId.Value || String.IsNullOrEmpty(instance.UniqueId)
                    || instance.GetTypeId()==null || instance.GetTypeId().Value!=oldId || !instance.IsValidType(newType.Id))
                    throw new InvalidOperationException("Each instance must be ungrouped, retain its expected old family type and accept the target type.");
                expected.Add(new TypeChangeExpectation { ElementId=id, BeforeTypeId=oldId, TargetTypeId=newId, UniqueId=instance.UniqueId });
            }
            foreach(var item in expected)
            {
                FamilyInstance current=doc.GetElement(new ElementId(item.ElementId)) as FamilyInstance;
                if(current==null || !current.IsValidObject || current.Document!=doc || current.UniqueId!=item.UniqueId || current.GroupId==null || current.GroupId.Value!=ElementId.InvalidElementId.Value
                    || current.GetTypeId().Value!=oldId || !current.IsValidType(newType.Id)) throw new InvalidOperationException("An instance changed after batch preflight.");
                ElementId replaced=current.ChangeTypeId(newType.Id);
                if(replaced==null || replaced.Value!=ElementId.InvalidElementId.Value) throw new InvalidOperationException("An instance was replaced by Revit; this batch must roll back.");
                VerifyTypeChange(doc,item);
            }
            return expected;
        }
        private static object VerifyFamilyTypeChanges(Document doc, Dictionary<string,object> args, List<TypeChangeExpectation> expected)
        {
            foreach(var item in expected)
            {
                Element current=doc.GetElement(new ElementId(item.ElementId));
                if (!(current is FamilyInstance) || current.Document!=doc) throw new InvalidOperationException("Family instance identity or ownership changed.");
                VerifyTypeChange(doc,item);
            }
            return new { old_type_id=DescribedId(new ElementId(NativeModelQueries.ExactId(args,"old_type_id"))), new_type_id=DescribedId(new ElementId(NativeModelQueries.ExactId(args,"new_type_id"))),
                element_ids=expected.Select(item=>DescribedId(new ElementId(item.ElementId))).ToArray(), changed_count=expected.Count };
        }
    }
}

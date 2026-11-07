using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Internal candidate only: host dispatcher is fail-closed until the trusted
    // Node decision, retained receipt and durable replay guard are connected.
    internal static class ProjectBindingCandidate
    {
        internal sealed class Plan
        {
            internal string Document, Mode, DataType, Scope;
            internal Guid Guid;
            internal long DefinitionId;
            internal long[] Categories;
        }
        internal static Plan Parse(Dictionary<string,object> args)
        {
            NativeModelQueries.Fields(args,"expected_document","mode","definition_guid","definition_id","data_type","category_ids");
            object d,m,g,t,c;Guid guid;
            if(!args.TryGetValue("expected_document",out d)||!(d is string)||String.IsNullOrWhiteSpace((string)d)||((string)d).Length>32768||!args.TryGetValue("mode",out m)||!(m is string)||((string)m!="commit"&&(string)m!="rollback")||!args.TryGetValue("definition_guid",out g)||!(g is string)||!Guid.TryParseExact((string)g,"D",out guid)||(string)g!=guid.ToString("D")||guid==Guid.Empty||!args.TryGetValue("data_type",out t)||!(t is string)||String.IsNullOrEmpty((string)t)||((string)t).Length>1024||!args.TryGetValue("category_ids",out c)||!(c is IList)) throw new InvalidOperationException("Invalid project binding proposal.");
            if(!args.ContainsKey("definition_id")||!(args["definition_id"] is string))throw new InvalidOperationException("Exact definition ID required.");
            long id=NativeModelQueries.ExactId(args,"definition_id");var ids=new List<long>();
            foreach(object raw in (IList)c){if(!(raw is string))throw new InvalidOperationException("Exact category ID required.");ids.Add(NativeModelQueries.ExactSignedId(new Dictionary<string,object>{{"id",raw}},"id"));}
            if(ids.Count<1||ids.Count>30||ids.Distinct().Count()!=ids.Count)throw new InvalidOperationException("Invalid category set.");
            ids.Sort();var plan=new Plan{Document=(string)d,Mode=(string)m,Guid=guid,DefinitionId=id,DataType=(string)t,Categories=ids.ToArray()};
            plan.Scope=new JavaScriptSerializer().Serialize(new {operation="bind_existing_project_parameter",expected_document=plan.Document,mode=plan.Mode,definition_guid=guid.ToString("D"),definition_id=id.ToString(CultureInfo.InvariantCulture),data_type=plan.DataType,category_ids=ids.Select(x=>x.ToString(CultureInfo.InvariantCulture)).ToArray()});return plan;
        }
        internal static ProjectInstanceBindingPreparation.Snapshot Capture(Document doc,Plan plan)
        {
            if(doc==null||doc.PathName!=plan.Document)throw new InvalidOperationException("Document changed.");
            return ProjectInstanceBindingPreparation.Capture(doc,plan.Guid,plan.DefinitionId,plan.DataType,plan.Categories);
        }
        private static void Verify(Document doc,Plan plan)
        {
            var element=SharedParameterElement.Lookup(doc,plan.Guid);if(element==null||!element.IsValidObject||element.Document==null||!element.Document.Equals(doc)||element.Id.Value!=plan.DefinitionId||element.GuidValue!=plan.Guid)throw new InvalidOperationException("Bound definition changed.");
            var definition=element.GetDefinition();if(definition==null||definition.Id.Value!=plan.DefinitionId||definition.GetDataType().TypeId!=plan.DataType)throw new InvalidOperationException("Bound data type changed.");
            var binding=doc.ParameterBindings.get_Item(definition) as InstanceBinding;if(binding==null||binding.Categories==null)throw new InvalidOperationException("Instance binding unavailable after insertion.");
            var ids=new List<long>();foreach(Category category in binding.Categories){if(category==null||category.Id==null)throw new InvalidOperationException("Invalid bound category.");ids.Add(category.Id.Value);}
            ids.Sort();if(!ids.SequenceEqual(plan.Categories))throw new InvalidOperationException("Bound category set differs.");
        }
        internal static object Execute(Document doc,Plan plan,ProjectBindingNativePreparation.Permit permit,string originalRequestId)
        {
            if(permit==null)throw new InvalidOperationException("Native permit required.");
            using(var transaction=new Transaction(doc,"BuildX: bind existing project parameter"))
            {
                if(transaction.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Could not start project binding transaction.");
                try
                {
                    permit.ClaimAndRevalidate(doc,plan.Scope,originalRequestId);
                    var element=SharedParameterElement.Lookup(doc,plan.Guid);var definition=element.GetDefinition();var categories=doc.Application.Create.NewCategorySet();
                    foreach(long id in plan.Categories){Category found=null;foreach(Category category in doc.Settings.Categories)if(category.Id.Value==id){if(found!=null)throw new InvalidOperationException("Ambiguous category.");found=category;}if(found==null||!categories.Insert(found))throw new InvalidOperationException("Category unavailable.");}
                    var binding=doc.Application.Create.NewInstanceBinding(categories);
                    if(!doc.ParameterBindings.Insert(definition,binding))throw new InvalidOperationException("Binding insertion failed.");
                    doc.Regenerate();Verify(doc,plan);
                    if(transaction.Commit()!=TransactionStatus.Committed)throw new InvalidOperationException("Binding transaction did not commit.");
                    Verify(doc,plan);
                    return new {definition_guid=plan.Guid.ToString("D"),definition_id=plan.DefinitionId.ToString(CultureInfo.InvariantCulture),data_type=plan.DataType,category_ids=plan.Categories.Select(x=>x.ToString(CultureInfo.InvariantCulture)).ToArray(),binding_kind="instance",original_preparation_request_id=originalRequestId};
                }
                catch {if(transaction.GetStatus()==TransactionStatus.Started)transaction.RollBack();throw;}
            }
        }
    }
}

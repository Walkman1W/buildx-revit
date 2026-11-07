using System;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Read-only preparation. It does not authorize or insert a binding, access
    // any shared-parameter file, or modify Application global state.
    internal static class ProjectInstanceBindingPreparation
    {
        internal sealed class InstanceFact
        {
            internal readonly long Id, CategoryId;
            internal readonly string UniqueId;
            internal InstanceFact(long id,long categoryId,string uniqueId){Id=id;CategoryId=categoryId;UniqueId=uniqueId;}
        }
        internal sealed class Snapshot
        {
            internal readonly Guid Guid;
            internal readonly long DefinitionId;
            internal readonly string DataType,DefinitionName,DocumentTitle,DocumentPath;
            private readonly long[] categoryIds;
            private readonly InstanceFact[] instances;
            internal long[] CategoryIds { get { return (long[])categoryIds.Clone(); } }
            internal InstanceFact[] Instances { get { return (InstanceFact[])instances.Clone(); } }
            internal Snapshot(Guid guid,long id,string dataType,string name,string title,string path,long[] categories,InstanceFact[] instances)
            {Guid=guid;DefinitionId=id;DataType=dataType;DefinitionName=name;DocumentTitle=title;DocumentPath=path;categoryIds=(long[])categories.Clone();this.instances=(InstanceFact[])instances.Clone();}
        }
        internal static object Read(Document doc, Dictionary<string, object> args)
        {
            NativeModelQueries.Fields(args, "expected_document", "definition_guid", "definition_id", "data_type", "category_ids");
            if (doc == null || String.IsNullOrWhiteSpace(doc.PathName)) throw new InvalidOperationException("A saved project is required.");
            object rawGuid, rawType, rawIds; Guid guid;
            if (!args.TryGetValue("definition_guid", out rawGuid) || !(rawGuid is string) || !Guid.TryParseExact((string)rawGuid, "D", out guid) || ((string)rawGuid) != guid.ToString("D") ||
                !args.TryGetValue("data_type", out rawType) || !(rawType is string) || !args.TryGetValue("category_ids", out rawIds) || !(rawIds is IList))
                throw new InvalidOperationException("Invalid preview arguments.");
            var ids = new List<long>();
            foreach (object raw in (IList)rawIds)
            {
                var one = new Dictionary<string, object> { { "id", raw } };
                if (!(raw is string)) throw new InvalidOperationException("Category IDs must be exact strings.");
                ids.Add(NativeModelQueries.ExactSignedId(one, "id"));
            }
            if (!args.ContainsKey("definition_id") || !(args["definition_id"] is string)) throw new InvalidOperationException("Definition ID must be an exact string.");
            return Describe(Capture(doc, guid, NativeModelQueries.ExactId(args, "definition_id"), (string)rawType, ids));
        }
        internal static Snapshot Capture(Document doc,Guid guid,long expectedDefinitionId,string expectedDataType,IList<long> requestedCategoryIds)
        {
            if(doc==null || doc.IsFamilyDocument || guid==Guid.Empty || expectedDefinitionId<=0 || String.IsNullOrEmpty(expectedDataType) || expectedDataType.Length>1024)
                throw new InvalidOperationException("A project document and exact definition identity are required.");
            if(requestedCategoryIds==null || requestedCategoryIds.Count<1 || requestedCategoryIds.Count>30 || requestedCategoryIds.Distinct().Count()!=requestedCategoryIds.Count || requestedCategoryIds.Any(id=>id==0||id==-1))
                throw new InvalidOperationException("Provide 1..30 distinct explicit category IDs.");
            SharedParameterElement element=SharedParameterElement.Lookup(doc,guid);
            if(element==null || !element.IsValidObject || element.Document==null || !element.Document.Equals(doc) || element.GuidValue!=guid || element.Id==null || element.Id.Value!=expectedDefinitionId)
                throw new InvalidOperationException("The exact document shared parameter definition is unavailable.");
            InternalDefinition definition=element.GetDefinition();
            if(definition==null || definition.Id==null || definition.Id.Value!=expectedDefinitionId || String.IsNullOrEmpty(definition.Name) || definition.GetDataType()==null
                || !String.Equals(definition.GetDataType().TypeId,expectedDataType,StringComparison.Ordinal)) throw new InvalidOperationException("Definition identity or data type changed.");
            if(doc.ParameterBindings==null || doc.ParameterBindings.Contains(definition)) throw new InvalidOperationException("Only an existing currently unbound definition is eligible.");
            var categories=new Dictionary<long,Category>();
            foreach(Category c in doc.Settings.Categories)
            {
                if(c==null || c.Id==null || categories.ContainsKey(c.Id.Value)) throw new InvalidOperationException("Category facts are ambiguous.");
                categories.Add(c.Id.Value,c);if(categories.Count>10000) throw new InvalidOperationException("Category scan budget exceeded.");
            }
            long[] ids=requestedCategoryIds.OrderBy(id=>id).ToArray();var facts=new List<InstanceFact>();var seen=new HashSet<long>();var seenUniqueIds=new HashSet<string>(StringComparer.Ordinal);int scanned=0;
            foreach(long categoryId in ids)
            {
                Category c;if(!categories.TryGetValue(categoryId,out c) || !c.AllowsBoundParameters || String.IsNullOrEmpty(c.Name)) throw new InvalidOperationException("Selected top-level category cannot be bound.");
                using(var collector=new FilteredElementCollector(doc).OfCategoryId(c.Id).WhereElementIsNotElementType())
                foreach(Element instance in collector)
                {
                    if(++scanned>100000) throw new InvalidOperationException("Instance scan budget exceeded; no partial impact is available.");
                    if(instance==null || !instance.IsValidObject || instance is ElementType || instance.Document==null || !instance.Document.Equals(doc) || instance.Id==null || instance.Id.Value<=0
                        || instance.Category==null || instance.Category.Id==null || instance.Category.Id.Value!=categoryId || String.IsNullOrEmpty(instance.UniqueId) || !seen.Add(instance.Id.Value) || !seenUniqueIds.Add(instance.UniqueId))
                        throw new InvalidOperationException("Instance identity or category cannot be verified.");
                    if(instance.get_Parameter(guid)!=null) throw new InvalidOperationException("An affected instance already exposes this GUID; conflict needs independent review.");
                    facts.Add(new InstanceFact(instance.Id.Value,categoryId,instance.UniqueId));
                    if(facts.Count>500) throw new InvalidOperationException("Impact exceeds 500 instances; no partial impact is available.");
                }
            }
            facts.Sort((a,b)=>a.Id.CompareTo(b.Id));
            return new Snapshot(guid,expectedDefinitionId,expectedDataType,definition.Name,doc.Title,doc.PathName,ids,facts.ToArray());
        }
        internal static void Revalidate(Document doc,Snapshot expected)
        {
            if(expected==null) throw new InvalidOperationException("A preparation snapshot is required.");
            Snapshot actual=Capture(doc,expected.Guid,expected.DefinitionId,expected.DataType,expected.CategoryIds);
            if(actual.DocumentTitle!=expected.DocumentTitle || actual.DocumentPath!=expected.DocumentPath || actual.DefinitionName!=expected.DefinitionName || !actual.CategoryIds.SequenceEqual(expected.CategoryIds) || actual.Instances.Length!=expected.Instances.Length)
                throw new InvalidOperationException("Definition, document, category or impact facts changed.");
            for(int i=0;i<actual.Instances.Length;i++)
                if(actual.Instances[i].Id!=expected.Instances[i].Id || actual.Instances[i].CategoryId!=expected.Instances[i].CategoryId || actual.Instances[i].UniqueId!=expected.Instances[i].UniqueId)
                    throw new InvalidOperationException("An affected instance identity or category changed.");
        }
        internal static object Describe(Snapshot snapshot)
        {
            if(snapshot==null) throw new InvalidOperationException("A preparation snapshot is required.");
            return new { schema_version=1, definition_guid=snapshot.Guid.ToString("D"), definition_id=snapshot.DefinitionId.ToString(CultureInfo.InvariantCulture), data_type=snapshot.DataType, definition_name=snapshot.DefinitionName,
                document_title=snapshot.DocumentTitle, document_path=snapshot.DocumentPath, binding_before="unbound", proposed_binding="instance", category_ids=snapshot.CategoryIds.Select(id=>id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                instance_count=snapshot.Instances.Length, instances=snapshot.Instances.Select(item=>new {element_id=item.Id.ToString(CultureInfo.InvariantCulture),category_id=item.CategoryId.ToString(CultureInfo.InvariantCulture),unique_id=item.UniqueId}).ToArray(),
                coverage="complete_current_document_instances", future_instances_affected=true, authorization="not_granted", host_session_bound=false, human_decision=false, binding_attempted=false, external_file_accessed=false };
        }
    }
}

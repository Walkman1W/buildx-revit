using System;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
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
        internal static object Read(Document doc, Dictionary<string, object> args, string hostSession)
        {
            NativeModelQueries.Fields(args, "expected_document", "definition_guid", "definition_id", "data_type", "category_ids", "offset", "limit", "expected_snapshot");
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
            int offset=NativeModelQueries.Page(args,"offset",0,0,500),limit=NativeModelQueries.Page(args,"limit",50,1,50);
            object rawSnapshot; string expected=null;
            if(args.TryGetValue("expected_snapshot",out rawSnapshot)) { expected=rawSnapshot as string; if(expected==null || expected.Length!=64 || expected.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f')))) throw new InvalidOperationException("Invalid preview snapshot identity."); }
            if(offset>0 && expected==null) throw new InvalidOperationException("Subsequent pages require the first page snapshot identity.");
            return Describe(Capture(doc, guid, NativeModelQueries.ExactId(args, "definition_id"), (string)rawType, ids),offset,limit,expected,hostSession);
        }
        internal static Snapshot Capture(Document doc,Guid guid,long expectedDefinitionId,string expectedDataType,IList<long> requestedCategoryIds)
        {
            var watch=Stopwatch.StartNew();
            Action checkTime=()=>{if(watch.ElapsedMilliseconds>=5000) throw new InvalidOperationException("Project binding preview time budget exceeded; no partial impact is available.");};
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
            checkTime();
            var categories=new Dictionary<long,Category>();
            foreach(Category c in doc.Settings.Categories)
            {
                checkTime();
                if(c==null || c.Id==null || categories.ContainsKey(c.Id.Value)) throw new InvalidOperationException("Category facts are ambiguous.");
                categories.Add(c.Id.Value,c);if(categories.Count>10000) throw new InvalidOperationException("Category scan budget exceeded.");
            }
            checkTime();
            long[] ids=requestedCategoryIds.OrderBy(id=>id).ToArray();var facts=new List<InstanceFact>();var seen=new HashSet<long>();var seenUniqueIds=new HashSet<string>(StringComparer.Ordinal);int scanned=0;
            foreach(long categoryId in ids)
            {
                checkTime();
                Category c;if(!categories.TryGetValue(categoryId,out c) || !c.AllowsBoundParameters || String.IsNullOrEmpty(c.Name)) throw new InvalidOperationException("Selected top-level category cannot be bound.");
                using(var collector=new FilteredElementCollector(doc).OfCategoryId(c.Id).WhereElementIsNotElementType())
                foreach(Element instance in collector)
                {
                    checkTime();
                    if(++scanned>100000) throw new InvalidOperationException("Instance scan budget exceeded; no partial impact is available.");
                    if(instance==null || !instance.IsValidObject || instance is ElementType || instance.Document==null || !instance.Document.Equals(doc) || instance.Id==null || instance.Id.Value<=0
                        || instance.Category==null || instance.Category.Id==null || instance.Category.Id.Value!=categoryId || String.IsNullOrEmpty(instance.UniqueId) || !seen.Add(instance.Id.Value) || !seenUniqueIds.Add(instance.UniqueId))
                        throw new InvalidOperationException("Instance identity or category cannot be verified.");
                    if(instance.get_Parameter(guid)!=null) throw new InvalidOperationException("An affected instance already exposes this GUID; conflict needs independent review.");
                    facts.Add(new InstanceFact(instance.Id.Value,categoryId,instance.UniqueId));
                    if(facts.Count>500) throw new InvalidOperationException("Impact exceeds 500 instances; no partial impact is available.");
                }
                checkTime();
            }
            checkTime();
            facts.Sort((a,b)=>a.Id.CompareTo(b.Id));
            checkTime();
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
        internal static string Fingerprint(Snapshot snapshot, string hostSession)
        {
            using(var bytes=new MemoryStream())
            {
                using(var writer=new BinaryWriter(bytes,Encoding.UTF8,true))
                {
                    if(String.IsNullOrEmpty(hostSession))throw new InvalidOperationException("Host session identity required.");
                    writer.Write("buildx-project-binding-impact-v1");writer.Write(hostSession);writer.Write(snapshot.Guid.ToString("D"));writer.Write(snapshot.DefinitionId);writer.Write(snapshot.DataType);writer.Write(snapshot.DefinitionName);writer.Write(snapshot.DocumentTitle);writer.Write(snapshot.DocumentPath);
                    var categories=snapshot.CategoryIds;writer.Write(categories.Length);foreach(long id in categories)writer.Write(id);
                    var instances=snapshot.Instances;writer.Write(instances.Length);foreach(var item in instances){writer.Write(item.Id);writer.Write(item.CategoryId);writer.Write(item.UniqueId);}
                }
                using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes.ToArray())).Replace("-","").ToLowerInvariant();
            }
        }
        // Full bounded facts must be in the same original atomic receipt as the native token.
        internal static object DescribeComplete(Snapshot snapshot, string hostSession)
        {
            if(snapshot==null)throw new InvalidOperationException("Complete project binding snapshot required.");
            return new { schema_version=1, definition_guid=snapshot.Guid.ToString("D"), definition_id=snapshot.DefinitionId.ToString(CultureInfo.InvariantCulture), data_type=snapshot.DataType, definition_name=snapshot.DefinitionName,
                document_title=snapshot.DocumentTitle, document_path=snapshot.DocumentPath, category_ids=snapshot.CategoryIds.Select(id=>id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                instance_count=snapshot.Instances.Length, instances=snapshot.Instances.Select(item=>new {element_id=item.Id.ToString(CultureInfo.InvariantCulture),category_id=item.CategoryId.ToString(CultureInfo.InvariantCulture),unique_id=item.UniqueId}).ToArray(),
                snapshot_id=Fingerprint(snapshot,hostSession), coverage="complete_current_document_instances", future_instances_affected=true, authorization="not_granted", binding_attempted=false, external_file_accessed=false };
        }
        internal static object Describe(Snapshot snapshot,int offset,int limit,string expectedSnapshot,string hostSession)
        {
            if(snapshot==null || offset<0 || offset>snapshot.Instances.Length || limit<1 || limit>50) throw new InvalidOperationException("Invalid preview page.");
            string fingerprint=Fingerprint(snapshot,hostSession);
            if((offset>0 && expectedSnapshot==null) || (expectedSnapshot!=null && expectedSnapshot!=fingerprint)) throw new InvalidOperationException("Preview impact changed; start a fresh preview.");
            var page=snapshot.Instances.Skip(offset).Take(limit).ToArray();
            return new { schema_version=1, definition_guid=snapshot.Guid.ToString("D"), definition_id=snapshot.DefinitionId.ToString(CultureInfo.InvariantCulture), data_type=snapshot.DataType, definition_name=snapshot.DefinitionName,
                document_title=snapshot.DocumentTitle, document_path=snapshot.DocumentPath, binding_before="unbound", proposed_binding="instance", category_ids=snapshot.CategoryIds.Select(id=>id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                instance_count=snapshot.Instances.Length, instances=page.Select(item=>new {element_id=item.Id.ToString(CultureInfo.InvariantCulture),category_id=item.CategoryId.ToString(CultureInfo.InvariantCulture),unique_id=item.UniqueId}).ToArray(),
                offset,limit,snapshot_id=fingerprint,has_more=offset+page.Length<snapshot.Instances.Length,
                coverage="complete_current_document_instances", future_instances_affected=true, authorization="not_granted", host_session_bound=false, human_decision=false, binding_attempted=false, external_file_accessed=false };
        }
    }
}

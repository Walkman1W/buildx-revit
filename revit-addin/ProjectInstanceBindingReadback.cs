using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Unregistered read-only building blocks for a possible bounded binding
    // writer. These facts neither invoke Insert nor grant an execution permit.
    internal static class ProjectInstanceBindingReadback
    {
        internal static object Review(Document doc, ProjectInstanceBindingPreparation.Snapshot expected)
        {
            if(expected==null || expected.Instances.Length>20) throw new InvalidOperationException("The complete review is limited to 20 existing instances.");
            ProjectInstanceBindingPreparation.Revalidate(doc,expected);
            var watch=Stopwatch.StartNew();int scanned=0;
            var selected=new HashSet<long>(expected.CategoryIds);var names=new Dictionary<long,string>();
            foreach(Category c in doc.Settings.Categories)
            {
                if(++scanned>10000 || watch.ElapsedMilliseconds>=5000)throw new InvalidOperationException("Review category budget exceeded.");
                if(c==null || c.Id==null || !selected.Contains(c.Id.Value)) continue;
                if(String.IsNullOrWhiteSpace(c.Name) || names.ContainsKey(c.Id.Value)) throw new InvalidOperationException("Category display facts are unavailable or ambiguous.");
                names.Add(c.Id.Value,c.Name);
            }
            if(watch.ElapsedMilliseconds>=5000)throw new InvalidOperationException("Review category time budget exceeded.");
            if(names.Count!=selected.Count) throw new InvalidOperationException("Category display facts changed.");
            return new { definition_guid=expected.Guid.ToString("D"),definition_id=expected.DefinitionId.ToString(CultureInfo.InvariantCulture),definition_name=expected.DefinitionName,data_type=expected.DataType,
                categories=expected.CategoryIds.Select(id=>new { category_id=id.ToString(CultureInfo.InvariantCulture),category_name=names[id] }).ToArray(),
                instances=expected.Instances.Select(x=>new {element_id=x.Id.ToString(CultureInfo.InvariantCulture),category_id=x.CategoryId.ToString(CultureInfo.InvariantCulture),unique_id=x.UniqueId}).ToArray(),
                future_instances_affected=true,human_decision=false,write_authorization="not_granted" };
        }

        internal static void VerifyBound(Document doc, ProjectInstanceBindingPreparation.Snapshot expected)
        {
            var watch=Stopwatch.StartNew();Action budget=()=>{if(watch.ElapsedMilliseconds>=5000)throw new InvalidOperationException("Binding readback time budget exceeded.");};
            if(doc==null || expected==null || expected.Instances.Length>20 || doc.IsFamilyDocument || doc.Title!=expected.DocumentTitle || doc.PathName!=expected.DocumentPath)throw new InvalidOperationException("Binding document or impact identity is unavailable.");
            var element=SharedParameterElement.Lookup(doc,expected.Guid);
            if(element==null || !element.IsValidObject || element.Document==null || !element.Document.Equals(doc) || element.GuidValue!=expected.Guid || element.Id==null || element.Id.Value!=expected.DefinitionId)throw new InvalidOperationException("Binding definition identity changed.");
            InternalDefinition definition=element.GetDefinition();
            if(definition==null || definition.Id==null || definition.Id.Value!=expected.DefinitionId || definition.Name!=expected.DefinitionName || definition.GetDataType()==null || definition.GetDataType().TypeId!=expected.DataType || doc.ParameterBindings==null || !doc.ParameterBindings.Contains(definition))throw new InvalidOperationException("Binding definition or state mismatch.");
            InstanceBinding binding=doc.ParameterBindings.get_Item(definition) as InstanceBinding;
            if(binding==null || binding.Categories==null)throw new InvalidOperationException("Binding is not an instance binding.");
            var bound=new HashSet<long>();
            foreach(Category c in binding.Categories){budget();if(c==null||c.Id==null||!bound.Add(c.Id.Value)||bound.Count>30)throw new InvalidOperationException("Binding categories are ambiguous.");}
            if(!bound.SetEquals(expected.CategoryIds))throw new InvalidOperationException("Binding categories changed.");
            var categories=new Dictionary<long,Category>();int scannedCategories=0;
            foreach(Category c in doc.Settings.Categories){budget();if(++scannedCategories>10000)throw new InvalidOperationException("Category scan budget exceeded.");if(c==null||c.Id==null)throw new InvalidOperationException("Category identity is unavailable.");if(bound.Contains(c.Id.Value)){if(categories.ContainsKey(c.Id.Value))throw new InvalidOperationException("Category identity is ambiguous.");categories.Add(c.Id.Value,c);}}
            if(categories.Count!=bound.Count)throw new InvalidOperationException("Bound category is missing.");
            var actual=new Dictionary<long,ProjectInstanceBindingPreparation.InstanceFact>();var uniqueIds=new HashSet<string>(StringComparer.Ordinal);int count=0;
            foreach(long categoryId in expected.CategoryIds)
            {
                budget();using(var collector=new FilteredElementCollector(doc).OfCategoryId(categories[categoryId].Id).WhereElementIsNotElementType())
                foreach(Element instance in collector)
                {
                    budget();if(++count>20||instance==null||!instance.IsValidObject||instance is ElementType||instance.Document==null||!instance.Document.Equals(doc)||instance.Id==null||instance.Id.Value<=0||instance.Category==null||instance.Category.Id==null||instance.Category.Id.Value!=categoryId||String.IsNullOrEmpty(instance.UniqueId)||actual.ContainsKey(instance.Id.Value)||!uniqueIds.Add(instance.UniqueId)||instance.get_Parameter(expected.Guid)==null)throw new InvalidOperationException("Affected instance identity or new parameter cannot be verified.");
                    actual.Add(instance.Id.Value,new ProjectInstanceBindingPreparation.InstanceFact(instance.Id.Value,categoryId,instance.UniqueId));
                }
                budget();
            }
            var prior=expected.Instances;if(actual.Count!=prior.Length)throw new InvalidOperationException("Affected instance set changed.");
            foreach(var fact in prior){ProjectInstanceBindingPreparation.InstanceFact observed;if(!actual.TryGetValue(fact.Id,out observed)||observed.CategoryId!=fact.CategoryId||observed.UniqueId!=fact.UniqueId)throw new InvalidOperationException("Affected instance identity changed.");}
            budget();
        }
    }
}

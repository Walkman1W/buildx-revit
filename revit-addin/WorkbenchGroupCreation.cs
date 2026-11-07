using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class GroupCreationExpectation
        {
            internal ElementId GroupId;
            internal string Name, GroupUniqueId;
            internal Dictionary<long, string> Members;
        }
        private static GroupCreationExpectation CreateModelGroup(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "name", "element_ids");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Model groups require a project document.");
            string name = SectionName(args);
            IList input = RequiredList(args, "element_ids", 2, 50);
            var members = new Dictionary<long, string>();
            var ids = new List<ElementId>();
            foreach (object raw in input)
            {
                long id = NativeModelQueries.ExactId(new Dictionary<string, object> { { "id", raw } }, "id");
                if (members.ContainsKey(id)) throw new InvalidOperationException("Duplicate member ID.");
                Element element = RequiredElement(doc, id);
                if (!element.IsValidObject || element is ElementType || element is Group || element.GroupId == null
                    || element.GroupId.Value != ElementId.InvalidElementId.Value || String.IsNullOrEmpty(element.UniqueId))
                    throw new InvalidOperationException("Every member must be a valid ungrouped non-group instance with a stable identity.");
                members.Add(id, element.UniqueId); ids.Add(element.Id);
            }
            Group group = doc.Create.NewGroup(ids);
            if (group == null || !group.IsValidObject || group.GroupType == null || String.IsNullOrEmpty(group.UniqueId))
                throw new InvalidOperationException("Group creation did not return a valid identity.");
            group.GroupType.Name = name;
            var expected = new GroupCreationExpectation { GroupId = group.Id, GroupUniqueId = group.UniqueId, Name = name, Members = members };
            VerifyModelGroup(doc, expected);
            return expected;
        }
        private static object VerifyModelGroup(Document doc, GroupCreationExpectation expected)
        {
            Group group = doc.GetElement(expected.GroupId) as Group;
            if (group == null || !group.IsValidObject || group.Category == null || group.Category.Id.Value != (long)BuiltInCategory.OST_IOSModelGroups
                || !String.Equals(group.UniqueId, expected.GroupUniqueId, StringComparison.Ordinal)
                || group.GroupType == null || !group.GroupType.IsValidObject || !String.Equals(group.GroupType.Name, expected.Name, StringComparison.Ordinal))
                throw new InvalidOperationException("Group identity or name changed.");
            ICollection<ElementId> observed = group.GetMemberIds();
            if (observed == null || observed.Count != expected.Members.Count || observed.Select(id => id.Value).Distinct().Count() != expected.Members.Count
                || observed.Any(id => !expected.Members.ContainsKey(id.Value)))
                throw new InvalidOperationException("Group direct member IDs differ from the requested instances; replacement or additional members are unsupported.");
            foreach (var pair in expected.Members)
            {
                Element element = doc.GetElement(new ElementId(pair.Key));
                if (element == null || !element.IsValidObject || element is ElementType || element is Group || element.GroupId == null
                    || element.GroupId.Value != expected.GroupId.Value || !String.Equals(element.UniqueId, pair.Value, StringComparison.Ordinal))
                    throw new InvalidOperationException("A requested member was replaced, moved or lost its identity.");
            }
            return new { element_id = DescribedId(group.Id), name = group.GroupType.Name,
                element_ids = expected.Members.Keys.OrderBy(id => id).Select(id => DescribedId(new ElementId(id))).ToArray() };
        }
    }
}

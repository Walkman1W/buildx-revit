using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        private sealed class UngroupExpectation { internal ElementId GroupId; internal string Name; internal Dictionary<long,string> Members; }
        private static UngroupExpectation UngroupOne(Document doc, Dictionary<string, object> args)
        {
            Fields(args, "expected_document", "mode", "group_id");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Ungroup requires a project document.");
            long id = NativeModelQueries.ExactId(args, "group_id");
            Group group = RequiredElement(doc, id) as Group;
            if (group == null || !group.IsValidObject || group.Category == null || group.Category.Id.Value != (long)BuiltInCategory.OST_IOSModelGroups
                || group.GroupId == null || group.GroupId.Value != ElementId.InvalidElementId.Value || group.GroupType == null || !group.GroupType.IsValidObject
                || String.IsNullOrEmpty(group.UniqueId) || String.IsNullOrEmpty(group.GroupType.Name)) throw new InvalidOperationException("group_id must identify a valid top-level model group.");
            ICollection<ElementId> attached = group.GetAvailableAttachedDetailGroupTypeIds();
            if (attached == null || attached.Count != 0) throw new InvalidOperationException("Groups with attached detail group types are unsupported.");
            ICollection<ElementId> ids = group.GetMemberIds();
            if (ids == null || ids.Count < 1 || ids.Count > 50) throw new InvalidOperationException("Group must have 1..50 direct members.");
            var members = new Dictionary<long,string>();
            foreach (ElementId memberId in ids)
            {
                if (memberId == null || memberId.Value <= 0 || members.ContainsKey(memberId.Value)) throw new InvalidOperationException("Group member IDs must be distinct and valid.");
                Element member = RequiredElement(doc, memberId.Value);
                if (!member.IsValidObject || member is ElementType || member is Group || member.GroupId == null || member.GroupId.Value != id || String.IsNullOrEmpty(member.UniqueId))
                    throw new InvalidOperationException("Group members must be valid directly owned non-group instances with stable identities.");
                members.Add(memberId.Value, member.UniqueId);
            }
            var expected = new UngroupExpectation { GroupId = group.Id, Name = group.GroupType.Name, Members = members };
            ICollection<ElementId> returned = group.UngroupMembers();
            if (returned == null || returned.Count != members.Count || returned.Any(x => x == null || !members.ContainsKey(x.Value)) || returned.Select(x => x.Value).Distinct().Count() != members.Count)
                throw new InvalidOperationException("Ungroup returned different or replaced members; transaction must roll back.");
            VerifyUngroup(doc, expected); return expected;
        }
        private static object VerifyUngroup(Document doc, UngroupExpectation expected)
        {
            if (doc.GetElement(expected.GroupId) != null) throw new InvalidOperationException("Original group remains after ungroup.");
            foreach (var pair in expected.Members)
            {
                Element member = doc.GetElement(new ElementId(pair.Key));
                if (member == null || !member.IsValidObject || member is ElementType || member is Group || member.GroupId == null
                    || member.GroupId.Value != ElementId.InvalidElementId.Value || !String.Equals(member.UniqueId, pair.Value, StringComparison.Ordinal))
                    throw new InvalidOperationException("A former member is missing, replaced or grouped after ungroup.");
            }
            return new { element_id = DescribedId(expected.GroupId), name = expected.Name, member_ids = expected.Members.Keys.OrderBy(id => id).Select(id => DescribedId(new ElementId(id))).ToArray(), member_count = expected.Members.Count };
        }
    }
}

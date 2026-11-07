using System;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        // Closed candidate only. The caller must bind a trusted human decision,
        // native preparation and request receipt before any production route exists.
        // This owns a transaction group and never saves the document.
        internal static object ExecuteBatchFilterCandidate(Document doc, string category, long? typeId, long? levelId,
            long parameterId, string storage, string unit, object target, string mode, object approvedSnapshot)
        {
            if (doc == null || (mode != "commit" && mode != "rollback")) throw new InvalidOperationException("Saved project and explicit mode required.");
            var phases = new BatchFilterWritePhases(approvedSnapshot, storage, unit, target);
            Func<object> capture = () => PreviewBatchParameterFilter(doc, category, typeId, levelId, parameterId);
            var serializer = new JavaScriptSerializer { MaxJsonLength = 180000, RecursionLimit = 16 };
            var facts = serializer.DeserializeObject(serializer.Serialize(approvedSnapshot)) as Dictionary<string, object>;
            if (facts == null || !(facts["items"] is object[])) throw new InvalidOperationException("Approved producer facts required.");
            var rows = (object[])facts["items"];
            Transaction inner = null; bool groupStarted = false;
            using (var group = new TransactionGroup(doc, "BuildX: batch filter candidate"))
            {
                try
                {
                    if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Transaction group could not start.");
                    groupStarted = true;
                    BatchFilterWriteCoordinator.Execute(phases, rows.Length, capture,
                        () => { inner = new Transaction(doc, "BuildX: batch filter candidate"); if (inner.Start() != TransactionStatus.Started) throw new InvalidOperationException("Transaction could not start."); },
                        index => {
                            var row = rows[index] as Dictionary<string, object>; long id;
                            if (row == null || !(row["element_id"] is string) || !Int64.TryParse((string)row["element_id"], NumberStyles.None, CultureInfo.InvariantCulture, out id)) throw new InvalidOperationException("Target identity invalid.");
                            Element element; Parameter parameter = ResolveInstanceParameter(doc, id, parameterId, out element);
                            object desired = NormalizeParameterValue(parameter, target, "value", true);
                            if (!Object.Equals(InternalValue(parameter), desired)) SetParameterValue(parameter, parameter.StorageType, desired);
                        },
                        () => doc.Regenerate(),
                        () => { if (inner.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Inner transaction did not commit."); },
                        () => { if (inner != null && inner.GetStatus() == TransactionStatus.Started) inner.RollBack(); if (groupStarted && group.GetStatus() == TransactionStatus.Started) { if (group.RollBack() != TransactionStatus.RolledBack) throw new InvalidOperationException("Outer rollback not confirmed."); groupStarted = false; } });
                    object after = capture(); phases.Verify(after, true);
                    // Fail before the outer group finishes if the evidence is not serializable.
                    var evidence = new { before = approvedSnapshot, after = after };
                    if (serializer.Serialize(evidence).Length > 180000) throw new InvalidOperationException("Batch result evidence exceeds budget.");
                    TransactionStatus finish = mode == "commit" ? group.Assimilate() : group.RollBack();
                    if (finish != (mode == "commit" ? TransactionStatus.Committed : TransactionStatus.RolledBack)) throw new InvalidOperationException("Group completion not confirmed.");
                    groupStarted = false;
                    return new { count = rows.Length, mode, transaction_status = finish.ToString(), saved = false, before = approvedSnapshot, after = after };
                }
                catch
                {
                    if (inner != null && inner.GetStatus() == TransactionStatus.Started) inner.RollBack();
                    if (groupStarted && group.GetStatus() == TransactionStatus.Started && group.RollBack() != TransactionStatus.RolledBack) throw new InvalidOperationException("Outer rollback not confirmed.");
                    throw;
                }
                finally { if (inner != null) inner.Dispose(); }
            }
        }
    }
}


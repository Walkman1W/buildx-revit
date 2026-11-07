using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static partial class WorkbenchActions
    {
        // Unregistered production candidate. The adapter that owns the queue,
        // user/session permission and original receipt is deliberately absent.
        // Only this entry uses a Revit-owned native dialog; JSON cannot supply
        // the decision. The test core is never exposed to the queue.
        internal static object RunBatchFilterNativeReview(UIApplication app, string hostSession, Dictionary<string, object> args, Func<bool> permissionCurrent)
        {
            return RunBatchFilterNativeReviewCore(app, hostSession, args, permissionCurrent, NativeBatchDialog);
        }
        private static bool NativeBatchDialog(string content)
        {
            var dialog = new TaskDialog("BuildX 批量参数确认");
            dialog.MainInstruction = "核对完整筛选、目标值和每项原态";
            dialog.MainContent = content;
            dialog.CommonButtons = TaskDialogCommonButtons.Yes | TaskDialogCommonButtons.No;
            dialog.DefaultButton = TaskDialogResult.No;
            return dialog.Show() == TaskDialogResult.Yes;
        }
        private static Dictionary<string, object> BatchDto(object preview)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 180000, RecursionLimit = 16 };
            var dto = serializer.DeserializeObject(serializer.Serialize(preview)) as Dictionary<string, object>;
            if (dto == null || !dto.ContainsKey("items") || !(dto["items"] is object[])) throw new InvalidOperationException("Complete batch preview required.");
            return dto;
        }
        private static void BatchContinue(Func<bool> permissionCurrent, UIApplication app, Document doc, Stopwatch clock)
        {
            if (permissionCurrent == null || !permissionCurrent() || app == null || app.ActiveUIDocument == null || !Object.ReferenceEquals(app.ActiveUIDocument.Document, doc) || !doc.IsValidObject || clock.ElapsedMilliseconds > 30000)
                throw new InvalidOperationException("Permission, document, or execution budget changed; operation not accepted.");
        }
        private static object BatchStage(Dictionary<string, object> original, ISet<string> completed, object target)
        {
            var rows = new List<object>();
            foreach (object item in (object[])original["items"])
            {
                var row = item as Dictionary<string, object>;
                if (row == null) throw new InvalidOperationException("Invalid batch preview row.");
                bool changed = completed.Contains((string)row["element_id"]);
                rows.Add(new { element_id = row["element_id"], unique_id = row["unique_id"], parameter_id = row["parameter_id"],
                    storage_type = row["storage_type"], has_value = changed ? true : (bool)row["has_value"], value_internal = changed ? target : row["value_internal"], data_type = row["data_type"] });
            }
            return new { schema_version = 1, scope = original["scope"], category = original["category"], type_id = original["type_id"], level_id = original["level_id"],
                parameter_id = original["parameter_id"], scanned = original["scanned"], complete = true, total = original["total"], items = rows.ToArray(), write_authorization = "not_granted" };
        }
        private static void BatchVerify(Document doc, string hostSession, object expected, string category, long? typeId, long? levelId, long parameterId, string storage, string unit, object target)
        {
            var guard = BatchFilterFactsGuard.Create(hostSession, doc, expected, storage, unit, target);
            guard.Compare(hostSession, doc, PreviewBatchParameterFilter(doc, category, typeId, levelId, parameterId), storage, unit, target);
        }
#if BUILDX_TESTS
        internal static object TestBatchFilterNativeReview(UIApplication app, string hostSession, Dictionary<string, object> args, Func<bool> permissionCurrent, Func<string, bool> decision)
        { return RunBatchFilterNativeReviewCore(app, hostSession, args, permissionCurrent, decision); }
#endif
        private static object RunBatchFilterNativeReviewCore(UIApplication app, string hostSession, Dictionary<string, object> args, Func<bool> permissionCurrent, Func<string, bool> nativeDecision)
        {
            if (app == null || app.ActiveUIDocument == null || app.ActiveUIDocument.Document == null || String.IsNullOrWhiteSpace(hostSession) || nativeDecision == null) throw new InvalidOperationException("Host, document and decision owner required.");
            Fields(args, "expected_document", "mode", "category", "type_id", "level_id", "parameter_id", "value", "value_unit");
            Document doc = app.ActiveUIDocument.Document;
            string expectedDocument = Required(args, "expected_document") as string, category = Required(args, "category") as string, mode = OptionalString(args, "mode", "rollback");
            if (String.IsNullOrWhiteSpace(expectedDocument) || !String.Equals(expectedDocument, doc.PathName, StringComparison.OrdinalIgnoreCase) || (mode != "rollback" && mode != "commit")) throw new InvalidOperationException("Bound document and transaction mode are required.");
            long? typeId = args.ContainsKey("type_id") ? (long?)NativeModelQueries.ExactId(args, "type_id") : null, levelId = args.ContainsKey("level_id") ? (long?)NativeModelQueries.ExactId(args, "level_id") : null;
            long parameterId = NativeModelQueries.ExactSignedId(args, "parameter_id");
            object rawValue = Required(args, "value"); string unit = args.ContainsKey("value_unit") ? OptionalString(args, "value_unit", "") : null;
            var clock = Stopwatch.StartNew(); BatchContinue(permissionCurrent, app, doc, clock);
            object preview = PreviewBatchParameterFilter(doc, category, typeId, levelId, parameterId);
            Dictionary<string, object> original = BatchDto(preview); object[] rows = (object[])original["items"];
            if (rows.Length < 1 || rows.Length > 20) throw new InvalidOperationException("A complete review requires 1 to 20 matching instances.");
            string storage = null; string dataType = null; object target = null; var serializer = new JavaScriptSerializer { MaxJsonLength = 180000, RecursionLimit = 16 };
            var text = new StringBuilder();
            text.Append("文档: ").Append(expectedDocument).Append("\n类别: ").Append(category).Append("\n类型 ID: ").Append(typeId.HasValue ? typeId.Value.ToString() : "全部").Append("\n标高 ID: ").Append(levelId.HasValue ? levelId.Value.ToString() : "全部").Append("\n参数 ID: ").Append(parameterId).Append("\n模式: ").Append(mode == "commit" ? "应用（不保存）" : "预览并回滚").Append("\n目标原始值: ").Append(serializer.Serialize(rawValue)).Append("\n单位: ").Append(unit ?? "无").Append("\n匹配总数: ").Append(rows.Length).Append("\n");
            foreach (object item in rows)
            {
                var row = item as Dictionary<string, object>; if (row == null) throw new InvalidOperationException("Invalid batch row.");
                string rowStorage = row["storage_type"] as string;
                if (storage == null) storage = rowStorage; else if (!String.Equals(storage, rowStorage, StringComparison.Ordinal)) throw new InvalidOperationException("All selected parameters must have the same storage type.");
                string rowDataType = row["data_type"] as string;
                if (rowDataType == null) throw new InvalidOperationException("Parameter data type must be known.");
                if (dataType == null) dataType = rowDataType; else if (!String.Equals(dataType, rowDataType, StringComparison.Ordinal)) throw new InvalidOperationException("All selected parameters must have the same data type.");
                long elementId = Int64.Parse((string)row["element_id"], System.Globalization.CultureInfo.InvariantCulture);
                Element owner; Parameter parameter = ResolveInstanceParameter(doc, elementId, parameterId, out owner);
                if (rowStorage == "Double" && unit != "internal" || rowStorage != "Double" && unit != null) throw new InvalidOperationException("Value unit must match storage type.");
                object desired = NormalizeParameterValue(parameter, rawValue, "value", true);
                if (target == null) target = desired; else if (!Object.Equals(target, desired)) throw new InvalidOperationException("Target normalization differs across selected parameters.");
                text.Append("\nID ").Append(row["element_id"]).Append("; UniqueId ").Append(serializer.Serialize(row["unique_id"]))
                    .Append("; 存储 ").Append(rowStorage).Append("; 有值 ").Append((bool)row["has_value"] ? "是" : "否")
                    .Append("; 原始值 ").Append(serializer.Serialize(row["value_internal"])).Append("; 数据类型 ").Append(serializer.Serialize(row["data_type"]));
                if (text.Length > 12000) throw new InvalidOperationException("Review is too large to present in the native dialog without truncation.");
            }
            var initialGuard = BatchFilterFactsGuard.Create(hostSession, doc, preview, storage, unit, target);
            BatchContinue(permissionCurrent, app, doc, clock);
            if (!nativeDecision(text.ToString())) return new { status = "declined", selected_count = rows.Length, committed = false, mode = mode, saved = false, reviewed = preview, target = target, value_unit = unit };
            BatchContinue(permissionCurrent, app, doc, clock);
            initialGuard.Compare(hostSession, doc, PreviewBatchParameterFilter(doc, category, typeId, levelId, parameterId), storage, unit, target);
            var completed = new HashSet<string>(StringComparer.Ordinal); var expectations = new List<ParameterWriteExpectation>();
            using (var group = new TransactionGroup(doc, "BuildX batch parameter filter"))
            {
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start transaction group.");
                try
                {
                    using (var transaction = new Transaction(doc, "BuildX guarded instance parameters"))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start parameter transaction.");
                        try
                        {
                            foreach (object item in rows)
                            {
                                BatchContinue(permissionCurrent, app, doc, clock);
                                BatchVerify(doc, hostSession, BatchStage(original, completed, target), category, typeId, levelId, parameterId, storage, unit, target);
                                var row = (Dictionary<string, object>)item;
                                var before = new Dictionary<string, object> { { "storage_type", row["storage_type"] }, { "has_value", row["has_value"] }, { "value_internal", row["value_internal"] }, { "data_type", row["data_type"] } };
                                var change = new Dictionary<string, object> { { "element_id", row["element_id"] }, { "parameter_id", row["parameter_id"] }, { "value", target }, { "expected_state", before } };
                                if (unit != null) change["value_unit"] = unit;
                                SetParameters(doc, new Dictionary<string, object> { { "expected_document", expectedDocument }, { "mode", mode }, { "changes", new object[] { change } } }, expectations, true);
                                completed.Add((string)row["element_id"]);
                                BatchVerify(doc, hostSession, BatchStage(original, completed, target), category, typeId, levelId, parameterId, storage, unit, target);
                            }
                            transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions().SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true));
                            doc.Regenerate(); VerifyParameterWrites(doc, expectations); BatchContinue(permissionCurrent, app, doc, clock);
                            BatchVerify(doc, hostSession, BatchStage(original, completed, target), category, typeId, levelId, parameterId, storage, unit, target);
                            if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Parameter transaction did not commit.");
                        }
                        catch (Exception failure)
                        {
                            try { if (transaction.GetStatus() == TransactionStatus.Started && transaction.RollBack() != TransactionStatus.RolledBack) throw new InvalidOperationException("Transaction rollback status is unknown."); }
                            catch (Exception rollbackFailure) { throw new InvalidOperationException("Batch outcome unknown: transaction rollback was not confirmed.", new AggregateException(failure, rollbackFailure)); }
                            throw;
                        }
                    }
                    VerifyParameterWrites(doc, expectations); BatchContinue(permissionCurrent, app, doc, clock);
                    BatchVerify(doc, hostSession, BatchStage(original, completed, target), category, typeId, levelId, parameterId, storage, unit, target);
                    TransactionStatus groupResult = mode == "commit" ? group.Assimilate() : group.RollBack();
                    if (groupResult != (mode == "commit" ? TransactionStatus.Committed : TransactionStatus.RolledBack)) throw new InvalidOperationException("Transaction group outcome unknown.");
                    if (mode == "rollback")
                    {
                        try { BatchVerify(doc, hostSession, preview, category, typeId, levelId, parameterId, storage, unit, target); }
                        catch (Exception readbackFailure) { throw new InvalidOperationException("Batch outcome unknown: rollback readback was not confirmed.", readbackFailure); }
                    }
                    return new { status = "completed", selected_count = rows.Length, committed = mode == "commit", mode = mode, saved = false, reviewed = preview, target = target, value_unit = unit };
                }
                catch (Exception failure)
                {
                    try
                    {
                        TransactionStatus status = group.GetStatus();
                        if (status == TransactionStatus.Started)
                        {
                            if (group.RollBack() != TransactionStatus.RolledBack) throw new InvalidOperationException("Transaction group rollback status is unknown.");
                            BatchVerify(doc, hostSession, preview, category, typeId, levelId, parameterId, storage, unit, target);
                        }
                        else if (status != TransactionStatus.RolledBack) throw new InvalidOperationException("Transaction group outcome is unknown.");
                    }
                    catch (Exception rollbackFailure) { throw new InvalidOperationException("Batch outcome unknown: group rollback was not confirmed.", new AggregateException(failure, rollbackFailure)); }
                    throw;
                }
            }
        }
    }
}

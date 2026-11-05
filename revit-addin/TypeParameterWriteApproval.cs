using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Web.Script.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // A preparation is a native review capability, not proof of human approval.
    // The Node trusted HTTP decision owns the separate human-confirmation proof.
    internal sealed class TypeParameterWriteApproval
    {
        internal const string PermitArgument = "__native_type_write_permit";
        internal sealed class Entry { internal Document Document; internal string Scope; internal long Tick; }
        internal sealed class Permit
        {
            private readonly TypeParameterWriteApproval owner;
            private readonly Entry entry;
            private bool used;
            private Permit(TypeParameterWriteApproval owner, Entry entry) { this.owner = owner; this.entry = entry; }
            internal void Claim(Document document, WorkbenchActions.TypeWritePlan plan)
            {
                if (used) throw new InvalidOperationException("Type-write native permit was already used.");
                used = true;
                if (owner.Expired(entry) || owner.sameDocument(entry.Document, document) != true || entry.Scope != plan.Scope)
                    throw new InvalidOperationException("Type-write native permit no longer matches the approved scope.");
            }
            internal static Permit FromEntry(TypeParameterWriteApproval owner, Entry entry) { return new Permit(owner, entry); }
        }
        private readonly string hostSession;
        private readonly Func<object, object, bool?> sameDocument;
        private readonly Func<long> clock;
        private readonly Func<DateTime> utcNow;
        private readonly long frequency;
        private readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        internal TypeParameterWriteApproval(string session, Func<object, object, bool?> documentIdentity)
            : this(session, documentIdentity, Stopwatch.GetTimestamp, Stopwatch.Frequency, () => DateTime.UtcNow) { }
        internal TypeParameterWriteApproval(string session, Func<object, object, bool?> documentIdentity, Func<long> monotonicClock, long clockFrequency, Func<DateTime> utcClock)
        {
            if (String.IsNullOrEmpty(session) || documentIdentity == null || monotonicClock == null || clockFrequency <= 0 || utcClock == null) throw new ArgumentException("Native approval requires a host, native document owner and clocks.");
            hostSession = session; sameDocument = documentIdentity; clock = monotonicClock; frequency = clockFrequency; utcNow = utcClock;
        }
        private bool Expired(Entry entry) { long now = clock(); return now < entry.Tick || ((double)now - entry.Tick) / frequency >= 120.0; }
        private void RequireProject(Document doc)
        {
            if (doc == null || sameDocument(doc, doc) != true || doc.IsFamilyDocument || doc.IsLinked || doc.IsReadOnly || String.IsNullOrWhiteSpace(doc.PathName))
                throw new InvalidOperationException("Type writes require the same valid saved project document.");
        }
        internal object Issue(Document doc, WorkbenchActions.TypeWritePlan plan)
        {
            RequireProject(doc);
            foreach (string token in entries.Where(pair => Expired(pair.Value)).Select(pair => pair.Key).ToArray()) entries.Remove(token);
            if (entries.Count >= 128) throw new InvalidOperationException("Type-write preparation capacity exceeded.");
            string key = Guid.NewGuid().ToString("N");
            entries.Add(key, new Entry { Document = doc, Scope = plan.Scope, Tick = clock() });
            return new { schema_version = 1, token = key, expires_utc = utcNow().AddSeconds(120).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) };
        }
        internal Permit Consume(Document doc, WorkbenchActions.TypeWritePlan plan, object provided)
        {
            RequireProject(doc);
            var wire = provided as Dictionary<string, object>; object schema, raw;
            if (wire == null || wire.Count != 2 || !wire.TryGetValue("schema_version", out schema) || !(schema is int) || (int)schema != 1 || !wire.TryGetValue("token", out raw) || !(raw is string))
                throw new InvalidOperationException("Type-write native approval is required.");
            string token = (string)raw;
            if (token.Length != 32 || token.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))) throw new InvalidOperationException("Type-write native approval is invalid.");
            Entry entry;
            if (!entries.TryGetValue(token, out entry)) throw new InvalidOperationException("Type-write native approval is missing or already consumed.");
            entries.Remove(token);
            if (Expired(entry) || sameDocument(entry.Document, doc) != true || entry.Scope != plan.Scope)
                throw new InvalidOperationException("Type-write native approval expired or changed scope.");
            // hostSession belongs to this book, never to the JSON request.
            if (String.IsNullOrEmpty(hostSession)) throw new InvalidOperationException("Type-write host is unavailable.");
            return Permit.FromEntry(this, entry);
        }
    }

    internal static partial class WorkbenchActions
    {
        internal sealed class TypeWritePlan
        {
            internal readonly long TypeId, ParameterId;
            internal readonly string ExpectedDocument, Mode, Unit, Scope;
            internal readonly object RawValue;
            internal readonly Dictionary<string, object> ExpectedState;
            internal readonly string[] InstanceIds;
            internal TypeWritePlan(long typeId, long parameterId, string document, string mode, string unit, object value, Dictionary<string, object> state, string[] ids)
            {
                TypeId = typeId; ParameterId = parameterId; ExpectedDocument = document; Mode = mode; Unit = unit; RawValue = value;
                ExpectedState = new Dictionary<string, object>(state, StringComparer.Ordinal); InstanceIds = (string[])ids.Clone();
                Scope = new JavaScriptSerializer().Serialize(new { operation = "set_type_parameter", expected_document = document, mode,
                    type_id = NativeModelQueries.SignedId(new ElementId(typeId)), parameter_id = NativeModelQueries.SignedId(new ElementId(parameterId)), value, value_unit = unit,
                    expected_state = new { storage_type = state["storage_type"], has_value = state["has_value"], value_internal = state["value_internal"], data_type = state["data_type"] }, expected_instance_ids = ids });
            }
        }
        internal sealed class TypeWritePreparation
        {
            internal readonly TypeWritePlan Plan;
            internal readonly NativeParameterQueries.TypeImpactSnapshot Impact;
            internal TypeWritePreparation(TypeWritePlan plan, NativeParameterQueries.TypeImpactSnapshot impact) { Plan = plan; Impact = impact; }
        }
        internal static TypeWritePlan ParseTypeWriteArguments(Dictionary<string, object> args)
        {
            if (args == null) throw new InvalidOperationException("Type-write arguments are required.");
            Fields(args, "expected_document", "mode", "type_id", "parameter_id", "value", "value_unit", "expected_state", "expected_instance_ids");
            long typeId = NativeModelQueries.ExactId(args, "type_id"), parameterId = NativeModelQueries.ExactSignedId(args, "parameter_id");
            string document = Required(args, "expected_document") as string, mode = OptionalString(args, "mode", "rollback"), unit = OptionalString(args, "value_unit", "");
            if (String.IsNullOrWhiteSpace(document) || document.Length > 32768 || mode != "commit" && mode != "rollback") throw new InvalidOperationException("Type-write saved document or mode is invalid.");
            if (args.ContainsKey("value_unit") && unit != "internal") throw new InvalidOperationException("value_unit must equal internal.");
            object value = Required(args, "value");
            if (value is string) { if (((string)value).Length > 8192) throw new InvalidOperationException("Type-write String exceeds 8192 characters."); }
            else value = FiniteNumber(value, "value");
            var state = Required(args, "expected_state") as Dictionary<string, object>;
            if (state == null) throw new InvalidOperationException("expected_state must be an object.");
            Fields(state, "storage_type", "has_value", "value_internal", "data_type");
            object storage = Required(state, "storage_type"), hasValue = Required(state, "has_value"), raw, data;
            if (!(storage is string) || !new[] { "Double", "Integer", "String" }.Contains((string)storage) || !(hasValue is bool) || !state.TryGetValue("value_internal", out raw) || !state.TryGetValue("data_type", out data) || data != null && (!(data is string) || ((string)data).Length > 1024))
                throw new InvalidOperationException("Type-write expected_state is invalid.");
            if (raw is string) { if (((string)raw).Length > 8192) throw new InvalidOperationException("Type-write expected String exceeds 8192 characters."); }
            else if (raw != null) raw = FiniteNumber(raw, "expected_state.value_internal");
            if (!(bool)hasValue && raw != null) throw new InvalidOperationException("A missing value must retain raw null.");
            var normalizedState = new Dictionary<string, object> { { "storage_type", storage }, { "has_value", hasValue }, { "value_internal", raw }, { "data_type", data } };
            IList suppliedIds = RequiredList(args, "expected_instance_ids", 0, 500); var ids = new string[suppliedIds.Count]; long previous = 0;
            for (int index = 0; index < ids.Length; index++)
            {
                if (!(suppliedIds[index] is string)) throw new InvalidOperationException("expected_instance_ids require canonical decimal strings.");
                long id = NativeModelQueries.ExactId(new Dictionary<string, object> { { "instance_id", suppliedIds[index] } }, "instance_id");
                if (id <= previous || id == typeId) throw new InvalidOperationException("expected_instance_ids must be unique numeric ascending instance IDs.");
                previous = id; ids[index] = NativeModelQueries.SignedId(new ElementId(id));
            }
            return new TypeWritePlan(typeId, parameterId, document, mode, unit, value, normalizedState, ids);
        }
        private static NativeParameterQueries.TypeImpactSnapshot CaptureTypeWritePhase(Document doc, TypeWritePlan plan, NativeModelQueries.ReadBudget budget, bool before, object desired, StorageType storage, string dataType, out object actualBefore, out object normalizedDesired, out ElementType type, out Parameter parameter)
        {
            var impact = NativeParameterQueries.CaptureTypeImpact(doc, plan.TypeId, plan.ParameterId, budget, out type, out parameter);
            NativeParameterQueries.RequireTypeOwner(doc, type, parameter, plan.TypeId, plan.ParameterId);
            string[] actualIds = impact.InstanceIds;
            if (!actualIds.SequenceEqual(plan.InstanceIds, StringComparer.Ordinal)) throw new InvalidOperationException("Type-write direct instance membership changed since approval.");
            actualBefore = null; normalizedDesired = desired;
            if (before)
            {
                if (parameter.IsReadOnly) throw new InvalidOperationException("Type parameter is read-only.");
                string actualDataType;
                actualBefore = ValidateParameterBefore(parameter, new Dictionary<string, object> { { "expected_state", plan.ExpectedState } }, InternalValue(parameter), out actualDataType);
                if (parameter.StorageType == StorageType.Double && plan.Unit != "internal") throw new InvalidOperationException("Double parameters require value_unit=internal.");
                normalizedDesired = NormalizeParameterValue(parameter, plan.RawValue, "value", true);
            }
            else
            {
                VerifyParameterValue(parameter, storage, desired);
                if (!String.Equals(ParameterDataType(parameter), dataType, StringComparison.Ordinal)) throw new InvalidOperationException("Type-write parameter data_type changed.");
            }
            return impact;
        }
        internal static TypeWritePreparation PrepareTypeParameterWrite(Document doc, Dictionary<string, object> args)
        {
            TypeWritePlan plan = ParseTypeWriteArguments(args); object actualBefore, desired;
            ElementType type; Parameter parameter;
            var impact = CaptureTypeWritePhase(doc, plan, new NativeModelQueries.ReadBudget(20000), true, null, StorageType.None, null, out actualBefore, out desired, out type, out parameter);
            return new TypeWritePreparation(plan, impact);
        }
        private static object WriteTypeParameter(UIApplication uiapp, Dictionary<string, object> wireArgs)
        {
            var args = new Dictionary<string, object>(wireArgs, StringComparer.Ordinal); object raw;
            if (!args.TryGetValue(TypeParameterWriteApproval.PermitArgument, out raw)) throw new InvalidOperationException("Type-write native permit is required.");
            args.Remove(TypeParameterWriteApproval.PermitArgument);
            var permit = raw as TypeParameterWriteApproval.Permit;
            if (permit == null) throw new InvalidOperationException("Type-write native permit is invalid.");
            TypeWritePlan plan = ParseTypeWriteArguments(args); Document doc = uiapp.ActiveUIDocument.Document;
            permit.Claim(doc, plan);
            var budget = new NativeModelQueries.ReadBudget(20000);
            using (var transaction = new Transaction(doc, "Local Codex: set_type_parameter"))
            {
                if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Could not start type-write transaction.");
                try
                {
                    object before, desired;
                    ElementType type; Parameter parameter;
                    CaptureTypeWritePhase(doc, plan, budget, true, null, StorageType.None, null, out before, out desired, out type, out parameter);
                    // These wrappers belong only to the just-completed stage.
                    if (parameter.IsReadOnly) throw new InvalidOperationException("Type parameter is read-only.");
                    string dataType = ParameterDataType(parameter); StorageType storage = parameter.StorageType; object prior = InternalValue(parameter);
                    string verifiedDataType; before = ValidateParameterBefore(parameter, new Dictionary<string, object> { { "expected_state", plan.ExpectedState } }, prior, out verifiedDataType);
                    bool changed = !Object.Equals(prior, desired);
                    if (changed) SetParameterValue(parameter, storage, desired);
                    object unusedBefore, unusedDesired;
                    CaptureTypeWritePhase(doc, plan, budget.Fork(), false, desired, storage, dataType, out unusedBefore, out unusedDesired, out type, out parameter);
                    transaction.SetFailureHandlingOptions(transaction.GetFailureHandlingOptions().SetFailuresPreprocessor(new RejectErrors()).SetClearAfterRollback(true));
                    doc.Regenerate();
                    CaptureTypeWritePhase(doc, plan, budget.Fork(), false, desired, storage, dataType, out unusedBefore, out unusedDesired, out type, out parameter);
                    TransactionStatus completion = transaction.Commit();
                    if (completion != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not commit the type-write operation; transaction status: " + completion);
                    CaptureTypeWritePhase(doc, plan, budget.Fork(), false, desired, storage, dataType, out unusedBefore, out unusedDesired, out type, out parameter);
                    return new { schema_version = 1, target_kind = "type", before, instance_ids = (string[])plan.InstanceIds.Clone(), instance_count = plan.InstanceIds.Length,
                        scope = "current_document_direct_type_references", indirect_effects = "not_assessed", result = new { updated_count = 1, changes = new[] { new {
                            element_id = NativeModelQueries.SignedId(type.Id), parameter_id = NativeModelQueries.SignedId(new ElementId(plan.ParameterId)), storage_type = storage.ToString(),
                            data_type = dataType, changed, before_internal = prior, after_internal = desired } } } };
                }
                catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
            }
        }
    }
}

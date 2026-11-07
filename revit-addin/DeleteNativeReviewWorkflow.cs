using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
namespace RevitLocalCodex
{
    // Unregistered candidate: no queue dispatcher or tool may call this until
    // host document/access/cancellation binding and receipt semantics are wired.
    internal static class DeleteNativeReviewWorkflow
    {
        internal enum Stage { Preview, Delete }
        internal sealed class Result { internal string Status; internal DeleteRollbackPreview.Result Preview; }
        private static int inProgress;
        private static void RequireCurrent(Func<bool> current)
        {
            if (current == null || current() != true) throw new InvalidOperationException("Delete request, access or active document changed.");
        }
        internal static Result Execute(Document doc, string path, long id, string uid, string requestId, string session, string kind, string mode, Func<bool> current)
        {
            // Only this native UI adapter may be wired to the host; a JSON value,
            // delegate supplied by a model, or generic panel checkbox is not proof.
            return ExecuteControlled(doc, path, id, uid, requestId, session, kind, mode, current, NativeDecision);
        }
        private static bool SafeText(string text, int max)
        {
            if (String.IsNullOrWhiteSpace(text) || text.Length > max) return false;
            foreach (char c in text) if (Char.IsControl(c)) return false;
            return true;
        }
        private static bool NativeDecision(Stage stage, Document doc, long id, string uid, DeleteRollbackPreview.Result preview)
        {
            if (!SafeText(doc.Title, 1024) || !SafeText(doc.PathName, 32768) || !SafeText(uid, 256)) throw new InvalidOperationException("Document or target identity cannot be safely displayed.");
            var body = new StringBuilder();
            body.Append("模型：").Append(doc.Title).Append("\n路径：").Append(doc.PathName).Append("\n目标 ID：").Append(id.ToString(CultureInfo.InvariantCulture)).Append("\n目标 UniqueId：").Append(uid).Append("\n");
            if (stage == Stage.Preview) body.Append("将临时删除目标并尝试回滚，以获取级联影响。事务外副作用可能无法撤销。是否允许本次预览？");
            else
            {
                if (preview == null || preview.Deleted == null || preview.Deleted.Length < 1 || preview.Deleted.Length > 20) throw new InvalidOperationException("Delete review requires at most 20 fully visible affected elements.");
                body.Append("本次删除将影响以下全部 ").Append(preview.Deleted.Length).Append(" 个元素；提交不会自动保存模型：\n");
                foreach (var row in preview.Deleted)
                {
                    if (row == null || !SafeText(row.UniqueId, 256)) throw new InvalidOperationException("Affected identity cannot be safely displayed.");
                    Element current = doc.GetElement(new ElementId(row.Id));
                    if (current == null || !current.IsValidObject || current.UniqueId != row.UniqueId) throw new InvalidOperationException("Affected element identity changed before display.");
                    string name = String.IsNullOrWhiteSpace(current.Name) ? "（无名称）" : current.Name;
                    string category = current.Category == null || String.IsNullOrWhiteSpace(current.Category.Name) ? "（未分类）" : current.Category.Name;
                    if (!SafeText(name, 256) || !SafeText(category, 256)) throw new InvalidOperationException("Affected element details cannot be safely displayed.");
                    body.Append(row.Id.ToString(CultureInfo.InvariantCulture)).Append(" · ").Append(category).Append(" · ").Append(name).Append(" · ").Append(row.UniqueId).Append("\n");
                }
                body.Append("确认删除以上全部元素？");
            }
            // A fixed text budget avoids silent truncation; real UI layout still
            // needs device verification, so this workflow is not registered.
            if (body.Length > 12000) throw new InvalidOperationException("Delete review text exceeds the full-display budget.");
            var dialog = new TaskDialog(stage == Stage.Preview ? "BuildX 删除影响预览" : "BuildX 确认删除") {
                MainInstruction = stage == Stage.Preview ? "允许本次回滚预览？" : "确认本次删除？",
                MainContent = body.ToString(), CommonButtons = TaskDialogCommonButtons.Yes | TaskDialogCommonButtons.No,
                DefaultButton = TaskDialogResult.No };
            return dialog.Show() == TaskDialogResult.Yes;
        }
#if BUILDX_TESTS
        internal static Result ExecuteForTest(Document doc, string path, long id, string uid, string requestId, string session, string kind, string mode,
            Func<bool> current, Func<Stage, Document, long, string, DeleteRollbackPreview.Result, bool> decide)
        { return ExecuteControlled(doc, path, id, uid, requestId, session, kind, mode, current, decide); }
#endif
        // Private in production: a model-supplied decision callback cannot
        // replace the native TaskDialog adapter.
        private static Result ExecuteControlled(Document doc, string path, long id, string uid, string requestId, string session, string kind, string mode,
            Func<bool> current, Func<Stage, Document, long, string, DeleteRollbackPreview.Result, bool> decide)
        {
            if (Interlocked.CompareExchange(ref inProgress, 1, 0) != 0) throw new InvalidOperationException("Another delete review is in progress.");
            try
            {
                if (decide == null || !(mode == "rollback" || mode == "commit")) throw new InvalidOperationException("Invalid delete review mode.");
                RequireCurrent(current);
                if (!decide(Stage.Preview, doc, id, uid, null)) return new Result { Status = "preview_declined" };
                RequireCurrent(current);
                var preview = DeleteRollbackPreview.Capture(doc, path, id, uid, requestId, session, kind);
                if (preview.Deleted.Length > 20) throw new InvalidOperationException("Delete cascade exceeds the 20-element native review limit.");
                RequireCurrent(current); DeleteImpactGuard.VerifyBefore(doc, preview, requestId, session);
                if (mode == "rollback") return new Result { Status = "preview_rolled_back", Preview = preview };
                if (!decide(Stage.Delete, doc, id, uid, preview)) return new Result { Status = "delete_declined", Preview = preview };
                RequireCurrent(current); DeleteImpactGuard.VerifyBefore(doc, preview, requestId, session);
                bool rolledBack = false; Exception failure = null;
                using (var group = new TransactionGroup(doc, "BuildX confirmed delete"))
                {
                    if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Delete transaction group did not start.");
                    try
                    {
                        using (var transaction = new Transaction(doc, "BuildX confirmed delete"))
                        {
                            if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Delete transaction did not start.");
                            try
                            {
                                RequireCurrent(current); DeleteImpactGuard.VerifyBefore(doc, preview, requestId, session);
                                ICollection<ElementId> deleted = doc.Delete(new ElementId(id));
                                DeleteImpactGuard.VerifyDeleteResult(preview, deleted); doc.Regenerate(); DeleteImpactGuard.VerifyAbsent(doc, preview);
                                if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Delete transaction did not commit.");
                            }
                            catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                        }
                        DeleteImpactGuard.VerifyAbsent(doc, preview); RequireCurrent(current);
                        if (group.Assimilate() != TransactionStatus.Committed) throw new DeleteRollbackPreview.RollbackUnknownException(null);
                    }
                    catch (Exception error) { failure = error; }
                    if (failure != null)
                    {
                        try { if (group.GetStatus() == TransactionStatus.Started) rolledBack = group.RollBack() == TransactionStatus.RolledBack && group.GetStatus() == TransactionStatus.RolledBack; }
                        catch (Exception e) { throw new DeleteRollbackPreview.RollbackUnknownException(e); }
                        if (!rolledBack) throw new DeleteRollbackPreview.RollbackUnknownException(failure);
                        try { DeleteImpactGuard.VerifyBefore(doc, preview, requestId, session); }
                        catch (Exception e) { throw new DeleteRollbackPreview.RollbackUnknownException(e); }
                        throw new InvalidOperationException("Delete did not complete; group rollback was confirmed.", failure);
                    }
                }
                // Assimilation may trigger updaters or change the document after
                // inner commit. A failed readback can no longer be rolled back;
                // it must never be reported as a confirmed successful deletion.
                try { RequireCurrent(current); DeleteImpactGuard.VerifyAbsent(doc, preview); }
                catch (Exception e) { throw new DeleteRollbackPreview.RollbackUnknownException(e); }
                return new Result { Status = "committed", Preview = preview };
            }
            finally { Interlocked.Exchange(ref inProgress, 0); }
        }
    }
}

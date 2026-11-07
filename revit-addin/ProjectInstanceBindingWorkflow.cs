#if BUILDX_EXPERIMENTAL_PROJECT_BINDING || BUILDX_TESTS
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    // Unregistered. The eventual host owner must call this on the Revit UI
    // callback with its own document/session, access and cancellation guards.
    internal static class ProjectInstanceBindingWorkflow
    {
        private static bool AskHuman(string message)
        {
            using(var dialog=new TaskDialog("确认项目参数绑定"))
            {
                dialog.MainInstruction="确认本次项目参数绑定";dialog.MainContent=message;
                dialog.CommonButtons=TaskDialogCommonButtons.Yes | TaskDialogCommonButtons.No;dialog.DefaultButton=TaskDialogResult.No;
                return dialog.Show()==TaskDialogResult.Yes;
            }
        }
        internal static object Execute(Document doc, ProjectInstanceBindingPreparation.Snapshot expected, string hostSession, string requestId, string mode, Action guard)
        {
            return ExecuteCore(doc,expected,hostSession,requestId,mode,guard,AskHuman);
        }
#if BUILDX_TESTS
        internal static object ExecuteForTest(Document doc, ProjectInstanceBindingPreparation.Snapshot expected, string hostSession, string requestId, string mode, Action guard, Func<string,bool> decide)
        {
            return ExecuteCore(doc,expected,hostSession,requestId,mode,guard,decide);
        }
#endif
        private static string SafeText(string value, int maximum)
        {
            if(String.IsNullOrWhiteSpace(value)||value.Length>maximum||value.Any(c=>Char.IsControl(c)))throw new InvalidOperationException("Review text cannot be safely displayed.");
            return value;
        }
        private static string ReviewText(Document doc, ProjectInstanceBindingPreparation.Snapshot expected, string mode)
        {
            ProjectInstanceBindingReadback.Review(doc,expected);
            var selected=new HashSet<long>(expected.CategoryIds);var names=new Dictionary<long,string>();
            foreach(Category c in doc.Settings.Categories)if(c!=null&&c.Id!=null&&selected.Contains(c.Id.Value))names.Add(c.Id.Value,SafeText(c.Name,160));
            var text=new StringBuilder();text.Append("文档：").Append(SafeText(expected.DocumentTitle,1024)).Append("\n路径：").Append(SafeText(expected.DocumentPath,4096)).Append("\n定义：").Append(SafeText(expected.DefinitionName,160)).Append("\nGUID：").Append(expected.Guid.ToString("D")).Append("\n定义 ID：").Append(expected.DefinitionId.ToString(CultureInfo.InvariantCulture)).Append("\n数据类型：").Append(SafeText(expected.DataType,512));
            text.Append("\n实例绑定；未来属于这些类别的实例也会受到影响。\n类别：");
            foreach(long id in expected.CategoryIds)text.Append("\n").Append(id.ToString(CultureInfo.InvariantCulture)).Append(" ").Append(names[id]);
            text.Append("\n当前全部受影响实例（").Append(expected.Instances.Length).Append("）：");
            foreach(var item in expected.Instances)text.Append("\n").Append(item.Id.ToString(CultureInfo.InvariantCulture)).Append(" / 类别 ").Append(item.CategoryId.ToString(CultureInfo.InvariantCulture)).Append(" / ").Append(SafeText(item.UniqueId,512));
            text.Append(mode=="commit"?"\n\n确认在当前项目内绑定？项目不会自动保存。":"\n\n确认运行回滚预览？");
            if(text.Length>24000)throw new InvalidOperationException("Review facts exceed the native dialog budget.");
            return text.ToString();
        }
        private static void Guard(Action guard){if(guard==null)throw new InvalidOperationException("Native document, permission and cancellation guard required.");guard();}
        private static object Receipt(string requestId,string session,string outcome,string stage,string detail)
        {return new {request_id=requestId,host_session=session,outcome,stage,detail,operation="project_instance_binding_candidate",external_file_accessed=false,project_saved=false,no_replay=true};}
        private static object ExecuteCore(Document doc, ProjectInstanceBindingPreparation.Snapshot expected, string hostSession, string requestId, string mode, Action guard, Func<string,bool> decide)
        {
            Guid request;
            if(doc==null||expected==null||String.IsNullOrEmpty(hostSession)||!Guid.TryParseExact(requestId,"D",out request)||request==Guid.Empty||(mode!="commit"&&mode!="rollback")||decide==null)
                throw new InvalidOperationException("Exact candidate identity and mode are required.");
            Guard(guard);
            string display=ReviewText(doc,expected,mode);
            if(!decide(display))return Receipt(requestId,hostSession,"not_started","human_decision","declined");
            Guard(guard);ProjectInstanceBindingPreparation.Revalidate(doc,expected);
            bool groupStarted=false,groupCommitted=false;string stage="before_group";
            using(var group=new TransactionGroup(doc,"BuildX: project instance binding"))
            {
                try
                {
                    if(group.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Transaction group did not start.");
                    groupStarted=true;stage="group_started";Guard(guard);ProjectInstanceBindingPreparation.Revalidate(doc,expected);
                    var definition=SharedParameterElement.Lookup(doc,expected.Guid).GetDefinition();
                    var byId=new Dictionary<long,Category>();foreach(Category c in doc.Settings.Categories)if(c!=null&&c.Id!=null&&expected.CategoryIds.Contains(c.Id.Value))byId.Add(c.Id.Value,c);
                    if(byId.Count!=expected.CategoryIds.Length)throw new InvalidOperationException("Category identities changed.");
                    using(var transaction=new Transaction(doc,"BuildX: bind shared definition"))
                    {
                        if(transaction.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Transaction did not start.");
                        var categories=doc.Application.Create.NewCategorySet();foreach(long id in expected.CategoryIds)categories.Insert(byId[id]);
                        var binding=doc.Application.Create.NewInstanceBinding(categories);
                        stage="insert_attempted";if(!doc.ParameterBindings.Insert(definition,binding))throw new InvalidOperationException("Revit did not insert the requested binding.");
                        doc.Regenerate();ProjectInstanceBindingReadback.VerifyBound(doc,expected);stage="regenerated_verified";
                        if(transaction.Commit()!=TransactionStatus.Committed)throw new InvalidOperationException("Inner transaction was not committed.");
                    }
                    stage="inner_committed";ProjectInstanceBindingReadback.VerifyBound(doc,expected);stage="inner_verified";
                    Guard(guard);
                    if(mode=="rollback")
                    {
                        if(group.RollBack()!=TransactionStatus.RolledBack)throw new InvalidOperationException("Transaction group rollback is unconfirmed.");
                        groupStarted=false;stage="group_rolled_back";Guard(guard);ProjectInstanceBindingPreparation.Revalidate(doc,expected);
                        return Receipt(requestId,hostSession,"rolled_back_verified",stage,"unbound impact rechecked");
                    }
                    if(group.Assimilate()!=TransactionStatus.Committed)throw new InvalidOperationException("Transaction group commit is unconfirmed.");
                    groupStarted=false;groupCommitted=true;stage="group_committed";Guard(guard);ProjectInstanceBindingReadback.VerifyBound(doc,expected);
                    return Receipt(requestId,hostSession,"committed_verified","group_verified","binding and impact rechecked");
                }
                catch(Exception)
                {
                    if(groupCommitted)return Receipt(requestId,hostSession,"unknown",stage,"group committed; final verification failed");
                    try
                    {
                        if(groupStarted)
                        {
                            if(group.GetStatus()==TransactionStatus.Started && group.RollBack()!=TransactionStatus.RolledBack)throw new InvalidOperationException("Rollback unconfirmed.");
                            if(group.GetStatus()!=TransactionStatus.RolledBack)throw new InvalidOperationException("Rollback status is unknown.");
                        }
                        Guard(guard);ProjectInstanceBindingPreparation.Revalidate(doc,expected);
                        return Receipt(requestId,hostSession,"failed_rolled_back_verified",stage,"original unbound impact rechecked");
                    }
                    catch(Exception){return Receipt(requestId,hostSession,"unknown",stage,"rollback or original state could not be verified");}
                }
            }
        }
    }
}

#endif

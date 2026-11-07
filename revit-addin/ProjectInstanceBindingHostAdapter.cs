#if BUILDX_EXPERIMENTAL_PROJECT_BINDING || BUILDX_TESTS
using System;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Not registered with the host or Node. Shared queue filenames/content do
    // not establish a trustworthy uninterrupted request handle. The production
    // gate is deliberately constant false even in the experimental build.
    internal static class ProjectInstanceBindingHostAdapter
    {
        internal sealed class Context
        {
            internal readonly string RequestId, Session;
            internal readonly Document Document;
            internal readonly DateTime ExpiresUtc;
            internal readonly Func<string> CurrentSession;
            internal readonly Func<Document> ActiveDocument;
            internal readonly Func<object,object,bool?> SameDocument;
            internal readonly Action RequireAccess;
            internal readonly Func<bool> Cancelled;
            internal readonly Func<DateTime> UtcNow;
            internal Context(string requestId,string session,Document document,DateTime expiresUtc,Func<string> currentSession,Func<Document> activeDocument,Func<object,object,bool?> sameDocument,Action requireAccess,Func<bool> cancelled,Func<DateTime> utcNow)
            {
                Guid parsed;
                if(!Guid.TryParseExact(requestId,"D",out parsed)||parsed==Guid.Empty||String.IsNullOrEmpty(session)||document==null||expiresUtc.Kind!=DateTimeKind.Utc||currentSession==null||activeDocument==null||sameDocument==null||requireAccess==null||cancelled==null||utcNow==null)throw new InvalidOperationException("Native candidate request context is invalid.");
                RequestId=requestId;Session=session;Document=document;ExpiresUtc=expiresUtc;CurrentSession=currentSession;ActiveDocument=activeDocument;SameDocument=sameDocument;RequireAccess=requireAccess;Cancelled=cancelled;UtcNow=utcNow;
            }
            internal void Check()
            {
                DateTime now=UtcNow();
                if(now.Kind!=DateTimeKind.Utc||now>=ExpiresUtc||Cancelled()||CurrentSession()!=Session||SameDocument(Document,ActiveDocument())!=true)throw new InvalidOperationException("Request, deadline, cancellation, session or document changed.");
                RequireAccess();
                // Recheck after the potentially blocking policy owner.
                now=UtcNow();if(now.Kind!=DateTimeKind.Utc||now>=ExpiresUtc||Cancelled()||CurrentSession()!=Session||SameDocument(Document,ActiveDocument())!=true)throw new InvalidOperationException("Request identity changed during access validation.");
            }
        }
        private static object Receipt(Context context,string outcome,string reason)
        {return new {request_id=context.RequestId,host_session=context.Session,operation="project_instance_binding_candidate",outcome,reason,no_replay=true};}
        internal static object Execute(Context context,ProjectInstanceBindingPreparation.Snapshot expected,string mode)
        {
            if(context==null)throw new InvalidOperationException("Native candidate context required.");
            // No string, path, hash, queue claim or caller-supplied boolean can
            // enable the future channel. Fail before dialog or transaction.
            return Receipt(context,"not_started","trusted_request_handle_unavailable");
        }
#if BUILDX_TESTS
        internal static object ExecuteForTest(Context context,ProjectInstanceBindingPreparation.Snapshot expected,string mode,Func<bool> claimedHandle,Func<string,bool> decide)
        {
            if(context==null||claimedHandle==null||decide==null)throw new InvalidOperationException("Synthetic context required.");
            if(!claimedHandle())return Receipt(context,"not_started","trusted_request_handle_unavailable");
            Action guard=()=>{if(!claimedHandle())throw new InvalidOperationException("Claimed synthetic request identity changed.");context.Check();if(!claimedHandle())throw new InvalidOperationException("Claimed synthetic request identity changed.");};
            try {guard();}
            catch(Exception){return Receipt(context,"not_started","native_context_changed");}
            try{return ProjectInstanceBindingWorkflow.ExecuteForTest(context.Document,expected,context.Session,context.RequestId,mode,guard,decide);}
            catch(Exception){return Receipt(context,"unknown","workflow_outcome_unconfirmed");}
        }
#endif
    }
}
#endif

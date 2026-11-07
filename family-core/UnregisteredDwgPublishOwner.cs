#if BUILDX_EXPERIMENTAL_DWG_PUBLICATION || BUILDX_TESTS
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
namespace BuildX.FilePreparation
{
    // Research only. The production entry is closed even when compiled with
    // the experimental flag: no caller-controlled claim can establish human
    // approval, a complete stage manifest, or a trusted original request.
    internal static class UnregisteredDwgPublishOwner
    {
        internal sealed class Result {internal string RequestId,Outcome,Detail;internal bool NoReplay=true;}
        private static Result ResultOf(string request,string outcome,string detail){return new Result{RequestId=request,Outcome=outcome,Detail=detail};}
        internal static Result Execute(string requestId)
        {return ResultOf(requestId,"not_started","trusted_request_and_human_approval_unavailable");}
        private static byte[] Record(string request,string requestHash,string state,GuardedSingleArtifactPublisher.Plan plan)
        {
            return Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new {schema_version=1,request_id=request,request_sha256=requestHash,state,source_path=plan.SourcePath,source_identity=plan.SourceIdentity,source_sha256=plan.Sha256,bytes=plan.Bytes,destination_path=plan.DestinationPath,destination_directory_identity=plan.DestinationChain.Last().Identity}));
        }
        private static void SameChain(GuardedSingleArtifactPublisher.Entry[] expected,GuardedSingleArtifactPublisher.Entry[] actual)
        {if(expected.Length!=actual.Length||expected.Where((entry,index)=>entry.Identity!=actual[index].Identity||!String.Equals(entry.Path,actual[index].Path,StringComparison.OrdinalIgnoreCase)).Any())throw new InvalidOperationException("Stage directory identity changed.");}
        private static void ExactStage(GuardedSingleArtifactPublisher.JournalRoot stage)
        {
            var current=GuardedSingleArtifactPublisher.CaptureJournalRoot(stage.Directory);SameChain(stage.Chain,current.Chain);
            string[] entries=Directory.GetFileSystemEntries(stage.Directory);if(entries.Length!=1||!String.Equals(Path.GetFileName(entries[0]),"drawing.dwg",StringComparison.Ordinal))throw new InvalidOperationException("Stage is not exactly one drawing.dwg.");
        }
#if BUILDX_TESTS
        internal static Action TestBeforePublish;
#endif
        private static Result Core(string requestId,string requestHash,GuardedSingleArtifactPublisher.JournalRoot stage,GuardedSingleArtifactPublisher.JournalRoot journal,string destinationDirectory,string destinationName,Func<string,bool> humanDecision)
        {
            if(!Regex.IsMatch(requestHash??"",@"^[a-f0-9]{64}$")||stage==null||journal==null||humanDecision==null)throw new InvalidOperationException("Owned stage, journal and native decision required.");
            GuardedSingleArtifactPublisher.Plan plan;GuardedSingleArtifactPublisher.JournalRecord prior;
            try
            {
                ExactStage(stage);plan=GuardedSingleArtifactPublisher.Prepare(Path.Combine(stage.Directory,"drawing.dwg"),destinationDirectory,destinationName);SameChain(stage.Chain,plan.SourceChain);
                prior=GuardedSingleArtifactPublisher.AppendJournal(journal,requestId,0,null,Record(requestId,requestHash,"prepared",plan));
            }
            catch(Exception){return ResultOf(requestId,"unknown","stage_or_original_request_unverified");}
            bool approved;
            try{approved=humanDecision("Source: "+plan.SourcePath+"\nDestination: "+plan.DestinationPath+"\nBytes: "+plan.Bytes+"\nSHA-256: "+plan.Sha256+"\nDestination directory identity: "+plan.DestinationChain.Last().Identity);}
            catch(Exception){return ResultOf(requestId,"unknown","human_decision_unknown");}
            if(!approved)
            {
                try{GuardedSingleArtifactPublisher.AppendJournal(journal,requestId,1,prior,Record(requestId,requestHash,"declined",plan));return ResultOf(requestId,"declined","nothing_published");}
                catch(Exception){return ResultOf(requestId,"unknown","decline_receipt_unconfirmed");}
            }
            try
            {
                ExactStage(stage);
                prior=GuardedSingleArtifactPublisher.AppendJournal(journal,requestId,1,prior,Record(requestId,requestHash,"publishing",plan));
#if BUILDX_TESTS
                if(TestBeforePublish!=null)TestBeforePublish();
#endif
                var receipt=GuardedSingleArtifactPublisher.Publish(plan);
                if(receipt.Sha256!=plan.Sha256||receipt.Bytes!=plan.Bytes||receipt.DestinationPath!=plan.DestinationPath)throw new InvalidOperationException("Published file facts differ.");
                GuardedSingleArtifactPublisher.AppendJournal(journal,requestId,2,prior,Record(requestId,requestHash,"observed_published",plan));
                return ResultOf(requestId,"observed_published","not_production_authority");
            }
            catch(Exception){return ResultOf(requestId,"unknown","inspect_original_journal_and_destination_no_replay");}
        }
        internal static Result InspectOriginal(GuardedSingleArtifactPublisher.JournalRoot journal,string requestId,string requestHash,int revision)
        {
            try
            {
                var raw=GuardedSingleArtifactPublisher.ReadJournal(journal,requestId,revision);var value=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(raw.Contents));
                if(!Regex.IsMatch(requestHash??"",@"^[a-f0-9]{64}$")||!value.ContainsKey("request_id")||(string)value["request_id"]!=requestId||!value.ContainsKey("request_sha256")||(string)value["request_sha256"]!=requestHash||!value.ContainsKey("state"))throw new InvalidOperationException();
                string state=value["state"] as string;
                if(state=="declined"&&revision==1)return ResultOf(requestId,"declined","original_receipt_only");
                // A file observation stored before restart does not establish
                // present destination identity; no success claim or replay.
                return ResultOf(requestId,"unknown","original_receipt_requires_independent_reconciliation");
            }
            catch(Exception){return ResultOf(requestId,"unknown","original_receipt_unavailable");}
        }
#if BUILDX_TESTS
        internal static Result RunForTest(string requestId,string requestHash,GuardedSingleArtifactPublisher.JournalRoot stage,GuardedSingleArtifactPublisher.JournalRoot journal,string destinationDirectory,string destinationName,Func<string,bool> syntheticDecision)
        {return Core(requestId,requestHash,stage,journal,destinationDirectory,destinationName,syntheticDecision);}
#endif
    }
}
#endif

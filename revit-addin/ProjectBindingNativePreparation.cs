using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitLocalCodex
{
    // Closed candidate: native preparation proves neither human consent nor a write.
    // A future host dispatcher must issue this only in the original atomic callback.
    internal sealed class ProjectBindingNativePreparation
    {
        private sealed class Entry { internal Document Document; internal ProjectInstanceBindingPreparation.Snapshot Snapshot; internal string Scope, RequestId; internal long Tick; }
        internal sealed class Permit
        {
            private readonly ProjectBindingNativePreparation owner;
            private readonly Entry entry;
            private bool used;
            private Permit(ProjectBindingNativePreparation owner, Entry entry) { this.owner=owner; this.entry=entry; }
            internal void ClaimAndRevalidate(Document doc, string scope, string originalRequestId)
            {
                if(used) throw new InvalidOperationException("Project binding permit already used.");
                used=true;
                if(owner.Expired(entry) || owner.sameDocument(entry.Document,doc)!=true || entry.Scope!=scope || entry.RequestId!=originalRequestId)
                    throw new InvalidOperationException("Project binding permit identity, scope or lifetime changed.");
                ProjectInstanceBindingPreparation.Revalidate(doc,entry.Snapshot);
            }
            private static Permit Create(ProjectBindingNativePreparation owner, Entry entry) { return new Permit(owner,entry); }
            internal static Permit FromEntry(ProjectBindingNativePreparation owner, object entry) { return Create(owner,(Entry)entry); }
        }
        private readonly string session;
        private readonly Func<object,object,bool?> sameDocument;
        private readonly Func<long> clock;
        private readonly long frequency;
        private readonly Func<DateTime> utcNow;
        private readonly Dictionary<string,Entry> entries=new Dictionary<string,Entry>(StringComparer.Ordinal);
        internal ProjectBindingNativePreparation(string session,Func<object,object,bool?> sameDocument) : this(session,sameDocument,Stopwatch.GetTimestamp,Stopwatch.Frequency,()=>DateTime.UtcNow) { }
        internal ProjectBindingNativePreparation(string session,Func<object,object,bool?> sameDocument,Func<long> clock,long frequency,Func<DateTime> utcNow)
        {
            if(String.IsNullOrEmpty(session)||sameDocument==null||clock==null||frequency<=0||utcNow==null) throw new ArgumentException("Native preparation requires session, document identity and clocks.");
            this.session=session;this.sameDocument=sameDocument;this.clock=clock;this.frequency=frequency;this.utcNow=utcNow;
        }
        private bool Expired(Entry e) { long now=clock();return now<e.Tick || ((double)now-e.Tick)/frequency>=120.0; }
        private void Require(Document doc) { if(doc==null||sameDocument(doc,doc)!=true||doc.IsFamilyDocument||doc.IsLinked||doc.IsReadOnly||String.IsNullOrWhiteSpace(doc.PathName)) throw new InvalidOperationException("A valid saved project document is required."); }
        internal object Issue(Document doc,ProjectInstanceBindingPreparation.Snapshot snapshot,string scope,string requestId)
        {
            Require(doc);Guid parsed;
            if(snapshot==null||String.IsNullOrEmpty(scope)||scope.Length>100000||!Guid.TryParseExact(requestId,"D",out parsed)||requestId!=parsed.ToString("D")||snapshot.DocumentPath!=doc.PathName||snapshot.DocumentTitle!=doc.Title) throw new InvalidOperationException("Invalid original preparation identity.");
            foreach(string key in entries.Where(p=>Expired(p.Value)).Select(p=>p.Key).ToArray()) entries.Remove(key);
            if(entries.Count>=128) throw new InvalidOperationException("Project binding preparation capacity exceeded.");
            string token=Guid.NewGuid().ToString("N");entries.Add(token,new Entry{Document=doc,Snapshot=snapshot,Scope=scope,RequestId=requestId,Tick=clock()});
            return new {schema_version=1,token=token,request_id=requestId,snapshot_id=ProjectInstanceBindingPreparation.Fingerprint(snapshot,session),expires_utc=utcNow().AddSeconds(120).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture)};
        }
        internal Permit Consume(Document doc,string scope,string requestId,string token)
        {
            Require(doc);
            if(token==null||token.Length!=32||token.Any(c=>!((c>='0'&&c<='9')||(c>='a'&&c<='f')))) throw new InvalidOperationException("Invalid native preparation token.");
            Entry entry;if(!entries.TryGetValue(token,out entry))throw new InvalidOperationException("Native preparation missing or consumed.");entries.Remove(token);
            if(Expired(entry)||sameDocument(entry.Document,doc)!=true||entry.Scope!=scope||entry.RequestId!=requestId)throw new InvalidOperationException("Native preparation expired or changed identity.");
            return Permit.FromEntry(this,entry);
        }
    }
}


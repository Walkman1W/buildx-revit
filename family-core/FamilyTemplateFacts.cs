using System;

namespace BuildX.FamilyCore
{
    // These tags describe bytes observed through a fixed trusted source. They
    // do not certify Revit template validity, category or connector suitability.
    public enum FamilyTemplateState { Unknown, BytesVerified, NotFound, Rejected, TooLarge, Changed }
    public enum FamilyTemplateIssue
    {
        None, UnknownId, MissingFile, ReparsePoint, NonRegularFile,
        ReadFailure, EmptyFile, OverBudget, FileChanged, CleanupFailure
    }

    public sealed class FamilyTemplateObservation
    {
        public string TemplateId { get; private set; }
        public string SourcePath { get; private set; }
        public FamilyTemplateState State { get; private set; }
        public FamilyTemplateIssue Issue { get; private set; }
        public long? ByteLength { get; private set; }
        public string Sha256 { get; private set; }

        public FamilyTemplateObservation(string templateId, string sourcePath,
            FamilyTemplateState state, FamilyTemplateIssue issue, long? byteLength, string sha256)
        {
            TemplateId = templateId; SourcePath = sourcePath; State = state;
            Issue = issue; ByteLength = byteLength; Sha256 = sha256;
        }
    }

    public interface IFamilyTemplateSource
    {
        FamilyTemplateObservation Inspect(string templateId);
    }

    // Only trusted host configuration constructs these locations. Models select
    // fixed IDs; no public model endpoint accepts a path or an observation DTO.
    public sealed class FamilyTemplateLocation
    {
        public string Id { get; private set; }
        public string Path { get; private set; }
        public FamilyTemplateLocation(string id, string path) { Id = id; Path = path; }
    }
}

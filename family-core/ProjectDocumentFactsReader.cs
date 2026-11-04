using System;

namespace BuildX.FamilyCore
{
    /// <summary>
    /// Produces one partial source observation. Each getter has its own failure
    /// boundary; unknown fields never erase previously obtained facts. Getters
    /// are trusted read-only adapter callbacks, not model-supplied operations.
    /// </summary>
    public static class ProjectDocumentFactsReader
    {
        public static ProjectDocumentFacts Read(Func<bool> isValid,
            Func<bool> isFamilyDocument, Func<bool> isLinked, Func<bool> isReadOnly,
            Func<string> persistentFingerprint, Func<int> nativeOpenHash)
        {
            if (isValid == null || isFamilyDocument == null || isLinked == null ||
                isReadOnly == null || persistentFingerprint == null || nativeOpenHash == null)
                throw new ArgumentException("Six fixed document getters are required.");

            bool? valid = TryValue(isValid);
            // Invalid wrappers cannot receive further Revit API calls. Failure
            // to inspect validity is also not permission to call other getters.
            if (valid != true)
                return new ProjectDocumentFacts(valid, null, null, null, null, null);

            bool? family = TryValue(isFamilyDocument);
            bool? linked = TryValue(isLinked);
            bool? readOnly = TryValue(isReadOnly);
            // Preserve specific family/linked facts. Project metadata is not
            // needed for these rejected or still-unknown document categories.
            if (family != false || linked != false)
                return new ProjectDocumentFacts(valid, family, linked, readOnly, null, null);

            string fingerprint = TryText(persistentFingerprint);
            int? openHash = TryValue(nativeOpenHash);
            return new ProjectDocumentFacts(valid, family, linked, readOnly, fingerprint, openHash);
        }

        private static T? TryValue<T>(Func<T> read) where T : struct
        {
            try { return read(); }
            catch { return null; }
        }

        private static string TryText(Func<string> read)
        {
            try { return read(); }
            catch { return null; }
        }
    }
}

namespace BuildX.FamilyCore
{
    // Terminal outcome is evidence from native state, never from Dispose or
    // a cleanup-completed flag. Uninitialized/Pending/Started are not rollback.
    public static class FamilyTerminalOutcome
    {
        public static string FromStatus(string nativeStatus)
        {
            if (nativeStatus == "Committed") return "committed";
            if (nativeStatus == "RolledBack") return "rolled_back";
            return "unknown";
        }
        public static string OnFailure(string nativeStatus)
        {
            string outcome = FromStatus(nativeStatus);
            return outcome == "rolled_back" ? "failed_rolled_back" : outcome;
        }
    }
}

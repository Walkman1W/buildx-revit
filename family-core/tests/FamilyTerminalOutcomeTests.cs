using System;
using BuildX.FamilyCore;

internal static class FamilyTerminalOutcomeTests
{
    public static int Main()
    {
        string[] states = { "Committed", "RolledBack", "Uninitialized", "Started", "Pending", "Error", null, "Unknown", "committed", "" };
        int passed = 0;
        Console.WriteLine("TAP version 13");
        foreach (string state in states)
        {
            string expected = state == "Committed" ? "committed" : state == "RolledBack" ? "rolled_back" : "unknown";
            string expectedFailure = state == "RolledBack" ? "failed_rolled_back" : expected;
            bool correct = FamilyTerminalOutcome.FromStatus(state) == expected && FamilyTerminalOutcome.OnFailure(state) == expectedFailure;
            if (correct) passed++;
            Console.WriteLine((correct ? "ok " : "not ok ") + (Array.IndexOf(states, state) + 1) + " - native " + (state == null ? "null" : state.Length == 0 ? "empty" : state) + " is " + expected + " independent of cleanup completion");
        }
        Console.WriteLine("1.." + states.Length); Console.WriteLine("# tests " + states.Length);
        Console.WriteLine("# pass " + passed); Console.WriteLine("# fail " + (states.Length - passed));
        return passed == states.Length ? 0 : 1;
    }
}

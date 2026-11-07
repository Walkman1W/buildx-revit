using System;
// Offline build skeleton only: no SCM, IPC, privileges, or filesystem access.
// Never register as a Windows service: protected implementation is absent.
internal static class ProtectedOwnerServiceCandidate
{
    private static int Main(string[] args)
    {
        Console.Error.WriteLine("Unavailable: authenticated service identity, protected IPC and durable owner are not implemented.");
        return 6;
    }
}

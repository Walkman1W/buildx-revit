using System;

namespace RevitLocalCodex
{
    // Unregistered coordinator: adapter owns the outer transaction group and
    // supplies fresh native snapshots, ordered writes and inner transaction.
    // Failure always asks that outer owner to roll back, including after the
    // inner commit. No receipt or human decision is created here.
    internal static class BatchFilterWriteCoordinator
    {
        internal static void Execute(BatchFilterWritePhases phases, int count, Func<object> capture,
            Action begin, Action<int> write, Action regenerate, Action commitInner, Action rollbackOuter)
        {
            if (phases == null || count < 0 || count > 50 || count != phases.Count || capture == null || begin == null || write == null || regenerate == null || commitInner == null || rollbackOuter == null)
                throw new ArgumentException("Complete bounded transaction adapter required.");
            try
            {
                phases.VerifyProgress(capture(), 0);
                begin();
                for (int i = 0; i < count; i++)
                {
                    phases.VerifyProgress(capture(), i);
                    write(i);
                    phases.VerifyProgress(capture(), i + 1);
                }
                regenerate();
                phases.VerifyProgress(capture(), count);
                commitInner();
                phases.VerifyProgress(capture(), count);
            }
            catch
            {
                rollbackOuter();
                throw;
            }
        }
    }
}


#if BUILDX_SCOPED_AUTO_APPLY
using System;
using System.Collections.Generic;

namespace RevitLocalCodex
{
    internal static class ScopedAutoApply
    {
        internal const int Version = 1;
        internal static readonly string[] Operations = { "set_parameter_value", "create_group" };

        // This field is issued by the queue owner, outside model arguments.
        // The host still evaluates the live project policy before any write.
        internal static bool Requested(Dictionary<string, object> request, string operation,
            Dictionary<string, object> args, bool hasAccessBinding, bool atomicRead)
        {
            object value;
            if (!request.TryGetValue("scopedAutoApply", out value)) return false;
            if (!(value is bool)) throw new InvalidOperationException("Scoped auto apply must be a boolean.");
            if (!(bool)value) return false;

            object mode;
            if (!hasAccessBinding || atomicRead || Array.IndexOf(Operations, operation) < 0 ||
                args == null || !args.TryGetValue("mode", out mode) || !Object.Equals(mode, "commit"))
                throw new InvalidOperationException("Scoped auto apply requires a project-bound supported commit.");
            return true;
        }
    }
}
#endif

using System;

namespace BuildX.FamilyCore
{
    public enum FamilyBuilderKind { Valve, Cabinet }

    // Native gate, independent of UI/MCP validation. A cabinet cannot be
    // passed to legacy valve write/close paths which lack its human-approval
    // contract. This policy grants no approval or project mutation authority.
    public static class FamilyJobOperationPolicy
    {
        public static string Rejection(FamilyBuilderKind kind, string operation)
        {
            if (kind != FamilyBuilderKind.Valve && kind != FamilyBuilderKind.Cabinet) return "FAMILY_JOB_SCOPE_MISMATCH";
            if (operation == "family_inspect_job") return null;
            if (kind == FamilyBuilderKind.Cabinet)
            {
                if (operation == "family_close_job") return "FAMILY_CABINET_CLOSE_OPERATION_REQUIRED";
                if (operation == "family_save_job") return "FAMILY_CABINET_SAVE_OPERATION_REQUIRED";
                if (operation == "family_load_job") return "FAMILY_CABINET_LOAD_NOT_AVAILABLE";
                if (operation == "family_close_cabinet" || operation == "family_save_cabinet") return null;
            }
            else
            {
                if (operation == "family_close_cabinet") return "FAMILY_VALVE_CLOSE_OPERATION_REQUIRED";
                if (operation == "family_save_cabinet") return "FAMILY_VALVE_SAVE_OPERATION_REQUIRED";
                if (operation == "family_close_job" || operation == "family_save_job" || operation == "family_load_job") return null;
            }
            return "FAMILY_OPERATION_UNKNOWN";
        }
    }
}

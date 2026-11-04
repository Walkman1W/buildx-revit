using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;

// Revit-free deterministic planning facts; creation and verification belong to the family workflow.
namespace BuildX.FamilyCore
{
    public sealed class CabinetSpec
    {
        public readonly double WidthMm, DepthMm, HeightMm, ThicknessMm;
        public readonly int ShelfCount;
        public CabinetSpec(double widthMm, double depthMm, double heightMm, double thicknessMm, int shelfCount)
        { WidthMm = widthMm; DepthMm = depthMm; HeightMm = heightMm; ThicknessMm = thicknessMm; ShelfCount = shelfCount; }
    }

    public sealed class PanelBox
    {
        public readonly string Role;
        public readonly double X0, Y0, Z0, X1, Y1, Z1;
        internal PanelBox(string role, double x0, double y0, double z0, double x1, double y1, double z1)
        { Role = role; X0 = x0; Y0 = y0; Z0 = z0; X1 = x1; Y1 = y1; Z1 = z1; }
        public double VolumeMm3 { get { return (X1 - X0) * (Y1 - Y0) * (Z1 - Z0); } }
    }

    public sealed class Plan
    {
        public readonly CabinetSpec Spec;
        public readonly ReadOnlyCollection<PanelBox> Panels;
        public readonly double DoorGapMm;
        public readonly string Units = "mm";
        public readonly string Evidence = "derived_offline_plan";
        public readonly string RevitStatus = "not_created_or_verified";
        internal Plan(CabinetSpec spec, IList<PanelBox> panels, double doorGapMm)
        { Spec = spec; Panels = new ReadOnlyCollection<PanelBox>(new List<PanelBox>(panels)); DoorGapMm = doorGapMm; }
    }

    public sealed class PlanResult
    {
        public readonly bool Ok;
        public readonly string Code, Message;
        public readonly Plan Value;
        internal PlanResult(bool ok, string code, string message, Plan value)
        { Ok = ok; Code = code; Message = message; Value = value; }
    }

    public static class CabinetPlanner
    {
        // These are prototype resource limits, not engineering design criteria.
        public const double MaxDimensionMm = 100000;
        public const int MaxShelves = 64;
        public const double DoorGapMm = 2;
        private static bool Dimension(double value)
        { return !Double.IsNaN(value) && !Double.IsInfinity(value) && value > 0 && value <= MaxDimensionMm; }
        private static PlanResult Failure(string code, string message)
        { return new PlanResult(false, code, message, null); }

        // The public job contract is deliberately narrower than the internal
        // flex planner; the latter also evaluates the bounded test type.
        public static PlanResult CreateSupported(CabinetSpec spec)
        {
            if (spec == null) return Failure("SPEC_MISSING", "Cabinet dimensions are required.");
            if (!Dimension(spec.WidthMm) || spec.WidthMm < 300 || spec.WidthMm > 5000 ||
                !Dimension(spec.DepthMm) || spec.DepthMm < 150 || spec.DepthMm > 2500 ||
                !Dimension(spec.HeightMm) || spec.HeightMm < 300 || spec.HeightMm > 5000 ||
                !Dimension(spec.ThicknessMm) || spec.ThicknessMm < 6 || spec.ThicknessMm > 80 ||
                spec.ShelfCount < 0 || spec.ShelfCount > 8)
                return Failure("SUPPORTED_RANGE_INVALID", "The cabinet is outside the supported job dimensions or shelf count.");
            return Create(spec);
        }

        public static PlanResult Create(CabinetSpec spec)
        {
            if (spec == null) return Failure("SPEC_MISSING", "Cabinet dimensions are required.");
            double w = spec.WidthMm, d = spec.DepthMm, h = spec.HeightMm, t = spec.ThicknessMm;
            int n = spec.ShelfCount;
            if (!Dimension(w) || !Dimension(d) || !Dimension(h) || !Dimension(t))
                return Failure("DIMENSION_INVALID", "Dimensions must be finite, positive, and within the prototype resource bound.");
            if (n < 0 || n > MaxShelves)
                return Failure("SHELF_COUNT_INVALID", "Shelf count is outside the prototype resource bound.");
            if (w <= 2 * t || h <= 2 * t || d <= t || w <= DoorGapMm || h <= 2 * DoorGapMm)
                return Failure("GEOMETRY_INVALID", "Panel thickness or door gap leaves no positive cabinet interior.");
            double clearHeight = h - 2 * t - n * t;
            if (clearHeight <= 0)
                return Failure("SHELF_CLEARANCE_INVALID", "Shelves leave no positive clear height.");

            // Carcass is [0,w] x [0,d] x [0,h]; doors are in front at y=[-t,0].
            // Positive overlaps between panels are avoided; contact faces are allowed.
            List<PanelBox> panels = new List<PanelBox>();
            panels.Add(new PanelBox("left", 0, 0, 0, t, d, h));
            panels.Add(new PanelBox("right", w - t, 0, 0, w, d, h));
            panels.Add(new PanelBox("bottom", t, 0, 0, w - t, d, t));
            panels.Add(new PanelBox("top", t, 0, h - t, w - t, d, h));
            panels.Add(new PanelBox("back", t, d - t, t, w - t, d, h - t));
            double clearPerOpening = clearHeight / (n + 1);
            for (int i = 0; i < n; i++)
            {
                double z = t + (i + 1) * clearPerOpening + i * t;
                panels.Add(new PanelBox("shelf", t, 0, z, w - t, d - t, z + t));
            }
            double half = (w - DoorGapMm) / 2;
            panels.Add(new PanelBox("door_left", 0, -t, DoorGapMm, half, 0, h - DoorGapMm));
            panels.Add(new PanelBox("door_right", half + DoorGapMm, -t, DoorGapMm, w, 0, h - DoorGapMm));
            // Near machine precision even mathematically valid constraints can
            // collapse distinct faces or overlap after floating-point rounding.
            // Preserve that uncertainty as a failure rather than emit bad boxes.
            for (int i = 0; i < panels.Count; i++)
            {
                PanelBox a = panels[i];
                if (!(a.X1 > a.X0 && a.Y1 > a.Y0 && a.Z1 > a.Z0 && a.VolumeMm3 > 0) || Double.IsInfinity(a.VolumeMm3))
                    return Failure("PLAN_PRECISION_INVALID", "Numeric precision cannot represent a positive panel.");
                for (int j = i + 1; j < panels.Count; j++)
                {
                    PanelBox b = panels[j];
                    if (Math.Min(a.X1, b.X1) > Math.Max(a.X0, b.X0) &&
                        Math.Min(a.Y1, b.Y1) > Math.Max(a.Y0, b.Y0) &&
                        Math.Min(a.Z1, b.Z1) > Math.Max(a.Z0, b.Z0))
                        return Failure("PLAN_PRECISION_INVALID", "Numeric precision makes panel positions overlap.");
                }
            }
            return new PlanResult(true, "PLAN_OK", "Offline geometric plan; no Revit family has been created.", new Plan(spec, panels, DoorGapMm));
        }
    }
}

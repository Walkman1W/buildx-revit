using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using BuildX.FamilyCore;

internal static class CabinetPlanTests
{
    private static int assertions;
    private static void Check(bool condition, string reason)
    { assertions++; if (!condition) throw new Exception(reason); }
    private static bool Near(double a, double b) { return Math.Abs(a - b) < 1e-7; }
    private static bool PositiveOverlap(PanelBox a, PanelBox b)
    {
        return Math.Min(a.X1, b.X1) > Math.Max(a.X0, b.X0) &&
            Math.Min(a.Y1, b.Y1) > Math.Max(a.Y0, b.Y0) &&
            Math.Min(a.Z1, b.Z1) > Math.Max(a.Z0, b.Z0);
    }
    private static void CheckPlan(CabinetSpec spec)
    {
        PlanResult result = CabinetPlanner.Create(spec);
        Check(result.Ok && result.Code == "PLAN_OK", "valid dimensions must plan");
        Plan p = result.Value;
        Check(p.Units == "mm" && p.Evidence == "derived_offline_plan" && p.RevitStatus == "not_created_or_verified", "evidence boundary");
        Check(p.Panels.Count == spec.ShelfCount + 7, "expected panel count");
        Check(p.Panels.Count(x => x.Role == "shelf") == spec.ShelfCount, "shelf count");
        Check(p.Panels.All(x => x.X1 > x.X0 && x.Y1 > x.Y0 && x.Z1 > x.Z0 && x.VolumeMm3 > 0 && !Double.IsInfinity(x.VolumeMm3)), "positive panels");
        for (int i = 0; i < p.Panels.Count; i++)
            for (int j = i + 1; j < p.Panels.Count; j++)
                Check(!PositiveOverlap(p.Panels[i], p.Panels[j]), "panels must not overlap in volume");
        foreach (PanelBox box in p.Panels)
        {
            Check(box.X0 >= 0 && box.X1 <= spec.WidthMm && box.Z0 >= 0 && box.Z1 <= spec.HeightMm, "panel outside cabinet envelope");
            if (box.Role.StartsWith("door_")) Check(Near(box.Y0, -spec.ThicknessMm) && Near(box.Y1, 0), "door face outside carcass front");
            else Check(box.Y0 >= 0 && box.Y1 <= spec.DepthMm, "carcass panel depth");
        }
        PanelBox leftDoor = p.Panels.Single(x => x.Role == "door_left");
        PanelBox rightDoor = p.Panels.Single(x => x.Role == "door_right");
        Check(Near(rightDoor.X0 - leftDoor.X1, p.DoorGapMm), "door gap");
        Check(Near(leftDoor.X1 - leftDoor.X0, rightDoor.X1 - rightDoor.X0), "equal doors");
        var shelves = p.Panels.Where(x => x.Role == "shelf").OrderBy(x => x.Z0).ToArray();
        var openings = new List<double>();
        double at = spec.ThicknessMm;
        foreach (PanelBox shelf in shelves) { openings.Add(shelf.Z0 - at); at = shelf.Z1; }
        openings.Add(spec.HeightMm - spec.ThicknessMm - at);
        Check(openings.All(x => x > 0), "shelves leave clear openings");
        Check(openings.All(x => Near(x, openings[0])), "shelf openings even");
    }
    private static string Signature(Plan p)
    {
        return String.Join("|", p.Panels.Select(x => String.Join(",", new[] { x.Role, x.X0.ToString("R", CultureInfo.InvariantCulture), x.Y0.ToString("R", CultureInfo.InvariantCulture), x.Z0.ToString("R", CultureInfo.InvariantCulture), x.X1.ToString("R", CultureInfo.InvariantCulture), x.Y1.ToString("R", CultureInfo.InvariantCulture), x.Z1.ToString("R", CultureInfo.InvariantCulture) })).ToArray());
    }
    private static void Reject(CabinetSpec spec, string code)
    { PlanResult result = CabinetPlanner.Create(spec); Check(!result.Ok && result.Code == code && result.Value == null, "expected failure " + code); }

    public static int Main()
    {
        try
        {
            Check(CabinetPlanner.CreateSupported(new CabinetSpec(1200, 600, 2200, 18, 3)).Ok, "supported cabinet dimensions");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(299, 600, 2200, 18, 3)).Ok, "width below product range");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(1200, 2501, 2200, 18, 3)).Ok, "depth above product range");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(1200, 600, 299, 18, 3)).Ok, "height below product range");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(1200, 600, 2200, 81, 3)).Ok, "thickness above product range");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(1200, 600, 2200, 18, 9)).Ok, "shelf count above product range");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(1200, 600, 300, 80, 8)).Ok, "shelves must leave clear height");
            Check(!CabinetPlanner.CreateSupported(new CabinetSpec(Double.NaN, 600, 2200, 18, 3)).Ok, "nonfinite width rejected");
            CheckPlan(new CabinetSpec(1200, 600, 2400, 18, 3));
            Plan example = CabinetPlanner.Create(new CabinetSpec(1200, 600, 2400, 18, 3)).Value;
            Check(Near(example.Panels.Single(x => x.Role == "left").VolumeMm3, 18 * 600 * 2400), "left volume");
            Check(Near(example.Panels.Single(x => x.Role == "back").Y0, 582), "back location");
            CheckPlan(new CabinetSpec(400, 350, 450, 12, 0));
            var a = new CabinetSpec(1200, 600, 2400, 18, 3);
            var b = new CabinetSpec(900, 450, 1800, 16, 4);
            string before = Signature(CabinetPlanner.Create(a).Value);
            string changed = Signature(CabinetPlanner.Create(b).Value);
            Check(before != changed && before == Signature(CabinetPlanner.Create(a).Value), "A-B-A parameter flex deterministic");
            Reject(null, "SPEC_MISSING");
            Reject(new CabinetSpec(Double.NaN, 600, 2400, 18, 3), "DIMENSION_INVALID");
            Reject(new CabinetSpec(1200, Double.PositiveInfinity, 2400, 18, 3), "DIMENSION_INVALID");
            Reject(new CabinetSpec(-1, 600, 2400, 18, 3), "DIMENSION_INVALID");
            Reject(new CabinetSpec(100001, 600, 2400, 18, 3), "DIMENSION_INVALID");
            Reject(new CabinetSpec(1200, 600, 2400, 18, -1), "SHELF_COUNT_INVALID");
            Reject(new CabinetSpec(1200, 600, 2400, 18, 65), "SHELF_COUNT_INVALID");
            Reject(new CabinetSpec(36, 600, 2400, 18, 0), "GEOMETRY_INVALID");
            Reject(new CabinetSpec(1200, 18, 2400, 18, 0), "GEOMETRY_INVALID");
            Reject(new CabinetSpec(1200, 600, 54, 18, 1), "SHELF_CLEARANCE_INVALID");
            Reject(new CabinetSpec(1200, 600, 2400, 1e-300, 0), "PLAN_PRECISION_INVALID");
            Random random = new Random(92743);
            for (int i = 0; i < 100; i++)
            {
                double thickness = 10 + random.NextDouble() * 15;
                int count = random.Next(0, 8);
                CheckPlan(new CabinetSpec(200 + random.NextDouble() * 1800, 100 + random.NextDouble() * 900,
                    (count + 2) * thickness + 100 + random.NextDouble() * 2800, thickness, count));
            }
            Console.WriteLine("PASS offline cabinet geometry invariants, bounded inputs, and A-B-A flex; assertions=" + assertions);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    }
}

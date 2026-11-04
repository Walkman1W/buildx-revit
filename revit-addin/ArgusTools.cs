using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;
using System.IO;
using System.Reflection;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    internal static class ArgusTools
    {
        public static object Annotate(UIApplication uiapp, Dictionary<string, object> args)
        {
            var ids = ((IEnumerable)args["element_ids"]).Cast<object>().Select(Convert.ToInt64).ToArray();
            return Call("Annotate", new object[] { uiapp, ids, Convert.ToInt64(args["view_id"]), Convert.ToInt64(args["tag_type_id"]) });
        }
        public static object Schematic(UIApplication uiapp, Dictionary<string, object> args)
        {
            return Call("Schematic", new object[] { uiapp, Convert.ToInt64(args["start_element_id"]), Convert.ToString(args["schematic_type"]) });
        }
        // Only call our public facade in our private assembly; no vendor auth/container reflection.
        private static object Call(string method, object[] args)
        {
            string file = Path.Combine(WorkbenchHost.PrivateRuntimeRoot, "argus", "2024", "ArgusLearning.Core.dll");
            Assembly assembly = Assembly.LoadFrom(file);
            return Parse((string)assembly.GetType("RevitWorkbench.RecoveredTools", true).GetMethod(method, BindingFlags.Public | BindingFlags.Static).Invoke(null, args));
        }
        private static object Parse(string value) { return new JavaScriptSerializer { MaxJsonLength = 250000 }.DeserializeObject(value); }
    }
}

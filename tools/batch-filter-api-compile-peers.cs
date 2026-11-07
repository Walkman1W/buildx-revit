using System;
using Autodesk.Revit.DB;
namespace RevitLocalCodex {
 internal static class NativeModelQueries { internal class ReadBudget { internal int Scanned;internal ReadBudget(int max){} internal void Scan(){} internal void Reserve(object o){} } internal static string SignedId(ElementId id){return id.Value.ToString();} }
 internal static partial class WorkbenchActions {
  private static Element RequiredElement(Document d,long id){throw new NotImplementedException();}
  private static Parameter ResolveInstanceParameter(Document d,long id,long pid,out Element e){throw new NotImplementedException();}
  private static object InternalValue(Parameter p){throw new NotImplementedException();}
  private static string ParameterDataType(Parameter p){throw new NotImplementedException();}
  private static object NormalizeParameterValue(Parameter p,object value,string name,bool required){throw new NotImplementedException();}
  private static void SetParameterValue(Parameter p,StorageType storage,object value){throw new NotImplementedException();}
 }
}

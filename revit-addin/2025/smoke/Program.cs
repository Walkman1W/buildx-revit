using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class Program {
 static int Main() {
  var json = new JavaScriptSerializer {MaxJsonLength=1024, RecursionLimit=10};
  var obj=json.Deserialize<Dictionary<string,object>>("{\"operation\":\"search_elements\",\"args\":{\"limit\":10,\"ids\":[1,2]},\"atomic\":true}");
  var args=(Dictionary<string,object>)obj["args"];
  if ((string)obj["operation"] != "search_elements" || (int)args["limit"] != 10 || ((object[])args["ids"]).Length != 2 || !(bool)obj["atomic"]) return 1;
  var copy=json.Deserialize<Dictionary<string,object>>(json.Serialize(obj));
  if ((string)copy["operation"] != "search_elements") return 2;
  try {new JavaScriptSerializer{MaxJsonLength=2}.DeserializeObject("{\"x\":1}"); return 3;} catch (ArgumentException) {}
  Console.WriteLine("JSON dictionary, array, numbers, round-trip, and size limit: PASS"); return 0;
 }
}

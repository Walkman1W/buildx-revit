using System;using System.Text;
internal static class ServiceProtocolFixture {
 private static void Check(string request,string expected){string actual=ProtectedOwnerService.InspectProtocol(Encoding.UTF8.GetBytes(request));if(actual!=expected)throw new Exception(expected+" != "+actual);}
 static int Main(){try{
 Check("{\"version\":1,\"operation\":\"status\"}","unavailable");
 Check("{\"version\":1,\"operation\":\"reserve\"}","denied");
 Check("{\"version\":1,\"operation\":\"settle\"}","denied");
 Check("{\"version\":1,\"operation\":\"inspect\"}","denied");
 Check("{\"version\":1,\"operation\":\"reserve\",\"identity\":\"trusted\"}","invalid");
 Check("{\"version\":2,\"operation\":\"status\"}","invalid");Check("{}","invalid");Check("{","invalid");
 if(ProtectedOwnerService.InspectProtocol(new byte[4097])!="invalid"||ProtectedOwnerService.InspectProtocol(new byte[]{0xff})!="invalid")throw new Exception("bounds");
 try{ProtectedOwnerService.CreateAuthenticatedPipe();throw new Exception("pipe created");}catch(InvalidOperationException){}
 Console.WriteLine("ok");return 0;}catch(Exception e){Console.Error.WriteLine(e.Message);return 1;}}
}

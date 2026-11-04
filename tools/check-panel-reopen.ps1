$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourcePath = Join-Path $taskRoot 'revit-addin\LocalCodexRevit.cs'
$text = [IO.File]::ReadAllText($sourcePath)
$begin = $text.IndexOf('    public sealed class CodexPane', [StringComparison]::Ordinal)
$end = $text.IndexOf('    // BEGIN SERVICE STARTUP DIAGNOSTIC', $begin, [StringComparison]::Ordinal)
if ($begin -lt 0 -or $end -lt 0) { throw 'Pane producer boundaries are missing.' }
$taskDir = Join-Path ([IO.Path]::GetTempPath()) ('buildx-pane-open-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskDir) | Out-Null
$prefix = @"
using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;
using Grid = System.Windows.Controls.Grid;
using Color = System.Windows.Media.Color;
using WpfVisibility = System.Windows.Visibility;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Autodesk.Revit.UI;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
namespace System.Windows {
 public enum Visibility { Visible, Collapsed }
 public struct Thickness { public Thickness(double a){} public Thickness(double a,double b,double c,double d){} }
 public enum VerticalAlignment { Center }
 public enum HorizontalAlignment { Left }
 public enum TextWrapping { Wrap }
 public static class FontWeights { public static object SemiBold = null; }
}
namespace System.Windows.Media {
 public struct Color { public static Color FromRgb(byte r,byte g,byte b){return new Color();} }
 public class SolidColorBrush { public SolidColorBrush(Color c){} }
}
namespace System.Windows.Controls {
 public class ChildList : List<object> { }
 public class Page { public object Background,Content; public bool IsLoaded=true; public event EventHandler Loaded; }
 public class Grid { public ChildList Children=new ChildList(); }
 public class StackPanel { public object Margin,VerticalAlignment; public ChildList Children=new ChildList(); }
 public class TextBlock { public string Text; public double FontSize; public object FontWeight,Foreground,Margin,VerticalAlignment,TextWrapping; }
 public class Button { public object Content,Padding,Margin,HorizontalAlignment; public bool IsEnabled; public System.Windows.Visibility Visibility; public event EventHandler Click; }
 public class Border { public object Background,Child; public System.Windows.Visibility Visibility; }
}
namespace Autodesk.Revit.UI {
 public interface IDockablePaneProvider { void SetupDockablePane(DockablePaneProviderData data); }
 public class DockablePaneProviderData { public object FrameworkElement,InitialState; }
 public enum DockPosition { Right }
 public class DockablePaneState { public DockPosition DockPosition; }
}
namespace Microsoft.Web.WebView2.Core {
 public class CoreWebView2Environment { public static Task<CoreWebView2Environment> CreateAsync(object a,string b,object c){return Task.FromResult(new CoreWebView2Environment());} }
 public class CoreWebView2Settings { public bool AreHostObjectsAllowed,IsWebMessageEnabled,AreDevToolsEnabled,AreDefaultContextMenusEnabled,IsStatusBarEnabled; }
 public class CoreWebView2NavigationStartingEventArgs : EventArgs { public string Uri; public bool Cancel; }
 public class CoreWebView2NewWindowRequestedEventArgs : EventArgs { public bool Handled; }
 public class CoreWebView2NavigationCompletedEventArgs : EventArgs { public bool IsSuccess; }
 public enum CoreWebView2PermissionState { Deny }
 public class CoreWebView2PermissionRequestedEventArgs : EventArgs { public CoreWebView2PermissionState State; }
 public class CoreWebView2 {
  public int Count; public CoreWebView2Settings Settings=new CoreWebView2Settings();
  public event EventHandler<CoreWebView2NavigationStartingEventArgs> NavigationStarting;
  public event EventHandler<CoreWebView2NewWindowRequestedEventArgs> NewWindowRequested;
  public event EventHandler<CoreWebView2NavigationCompletedEventArgs> NavigationCompleted;
  public event EventHandler<CoreWebView2PermissionRequestedEventArgs> PermissionRequested;
  public void Navigate(string url){Count++;}
 }
}
namespace Microsoft.Web.WebView2.Wpf {
 public class WebView2 : IDisposable { public CoreWebView2 CoreWebView2=new CoreWebView2(); public Task EnsureCoreWebView2Async(CoreWebView2Environment e){return Task.FromResult(0);} public void Dispose(){} }
}
namespace RevitLocalCodex {
 internal static class App { public static bool AutoStartEnabled=true; public static string PanelAddress="http://127.0.0.1:41873/"; public static string ErrorCode(Exception e){return "error";} }
 internal static class LocalService {
  public static int Calls; public static Queue<Func<Action,Task<string>>> Results=new Queue<Func<Action,Task<string>>>();
  public static Task<string> EnsureAvailableAsync(bool allowStart,Action absent){ Calls++; return Results.Dequeue()(absent); }
 }
"@
$suffix = @"
 internal static class Tests {
  static BindingFlags flags=BindingFlags.Instance|BindingFlags.NonPublic;
  static void Set(object o,string n,object v){o.GetType().GetField(n,flags).SetValue(o,v);}
  static object Get(object o,string n){return o.GetType().GetField(n,flags).GetValue(o);}
  static void Check(bool ok,string name){if(!ok)throw new Exception(name); Console.WriteLine("PASS " + name);}
  static CodexPane Pane(){var p=new CodexPane();Set(p,"hasNavigated",true);Set(p,"browser",new WebView2());return p;}
  static int Nav(CodexPane p){return ((WebView2)Get(p,"browser")).CoreWebView2.Count;}
  static Task<string> Existing(Action a){return Task.FromResult<string>(null);}
  static Task<string> Absent(Action a){a();return Task.FromResult<string>(null);}
  static Task<string> Unknown(Action a){return Task.FromResult("identity unknown");}
  static int Main(){try {
   var p=Pane(); LocalService.Results.Enqueue(Existing);p.RequestOpen(); Check(LocalService.Calls==1 && Nav(p)==0,"healthy service probes without reload");
   p=Pane();LocalService.Results.Enqueue(Absent);p.RequestOpen();Check(Nav(p)==1,"recovered absent service navigates once");
   p=Pane();LocalService.Results.Enqueue(Unknown);p.RequestOpen();Check(Nav(p)==0 && ((Border)Get(p,"loadingSurface")).Visibility==Visibility.Visible,"unknown service does not navigate");
   p=Pane();var wait=new TaskCompletionSource<string>();LocalService.Results.Enqueue(a=>wait.Task);LocalService.Results.Enqueue(Existing);int prior=LocalService.Calls;p.RequestOpen();p.RequestOpen();Check(LocalService.Calls==prior+1,"concurrent open is queued");wait.SetResult(null);Check(LocalService.Calls==prior+2 && Nav(p)==0,"queued open completes without reload");
   p=Pane();var browser=(WebView2)Get(p,"browser");wait=new TaskCompletionSource<string>();LocalService.Results.Enqueue(a=>wait.Task);p.RequestOpen();p.Dispose();wait.SetResult(null);Check(browser.CoreWebView2.Count==0,"disposed pane ignores late probe");
   return 0;
  }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}}
 }
}
"@
$generated = Join-Path $taskDir 'PaneHarness.cs'
[IO.File]::WriteAllText($generated, $prefix + $text.Substring($begin,$end-$begin) + $suffix, [Text.UTF8Encoding]::new($false))
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $taskDir 'PaneHarness.exe'
& $compiler /nologo /target:exe /langversion:5 ('/out:'+$exe) $generated
if ($LASTEXITCODE -ne 0) { throw 'Harness compile failed.' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Pane regression failed.' }
[pscustomobject]@{scope='actual pane source with fake Revit/WPF/service; no real service or Revit';sourceHash=(Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash;testDirectory=$taskDir} | ConvertTo-Json -Compress

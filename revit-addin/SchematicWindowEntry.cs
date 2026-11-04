using System;
using System.Linq;
using System.Windows.Interop;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitLocalCodex
{
    [Transaction(TransactionMode.ReadOnly)]
    public sealed class OpenSchematicEditorCommand : IExternalCommand
    {
        private static SchematicEditorWindow editor;
        private static WindowWorkbenchClient client;

        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                if (editor != null) { editor.Activate(); return Result.Succeeded; }
                UIApplication application = commandData.Application;
                if (application.ActiveUIDocument == null || App.CurrentWorkbench == null)
                    throw new InvalidOperationException("请先打开已保存的 Revit 项目。");
                Document document = application.ActiveUIDocument.Document;
                if (string.IsNullOrWhiteSpace(document.PathName) || document.IsFamilyDocument)
                    throw new InvalidOperationException("系统图预览需要已保存的项目文档。");
                long initial = application.ActiveUIDocument.Selection.GetElementIds().Select(id => id.Value).FirstOrDefault();
                client = new WindowWorkbenchClient(WorkbenchHost.Root, App.CurrentWorkbench.SessionId);
                editor = new SchematicEditorWindow(client.SubmitAsync, document.PathName, initial);
                new WindowInteropHelper(editor).Owner = application.MainWindowHandle;
                editor.Closed += delegate {
                    editor = null;
                    if (client != null) { client.Dispose(); client = null; }
                };
                editor.Show();
                return Result.Succeeded;
            }
            catch (Exception error)
            {
                if (editor != null) { editor.CloseForHostShutdown(); editor = null; }
                if (client != null) { client.Dispose(); client = null; }
                message = "系统图窗口未能打开：" + error.Message;
                return Result.Failed;
            }
        }

        internal static void CloseForHostShutdown()
        {
            if (editor != null) editor.CloseForHostShutdown();
            if (client != null) { client.Dispose(); client = null; }
        }
    }

    public sealed class SchematicEditorAvailability : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories)
        {
            return applicationData.ActiveUIDocument != null;
        }
    }
}

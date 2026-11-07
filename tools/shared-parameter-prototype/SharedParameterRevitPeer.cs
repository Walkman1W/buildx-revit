using System;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
namespace RevitLocalCodex
{
    // Compile-only adapter; not registered or instantiated by the host.
    internal sealed class SharedParameterRevitPeer : ISharedParameterPeer
    {
        private readonly Application app;
        internal SharedParameterRevitPeer(Application app) { this.app = app; }
        public string Filename { get { return app.SharedParametersFilename; } set { app.SharedParametersFilename = value; } }
        public void CreateAndVerify(string path, string group, string name, Guid guid, string dataType)
        {
            if (!String.Equals(Filename, path, StringComparison.Ordinal)) throw new InvalidOperationException("File setting drift.");
            var file = app.OpenSharedParameterFile();
            if (file == null) throw new InvalidOperationException("Revit did not open the isolated file.");
            var g = file.Groups.Create(group);
            var options = new ExternalDefinitionCreationOptions(name, new ForgeTypeId(dataType));
            options.GUID = guid;
            var definition = g.Definitions.Create(options) as ExternalDefinition;
            if (definition == null || definition.GUID != guid || definition.Name != name || definition.GetDataType().TypeId != dataType || g.Name != group || !String.Equals(Filename, path, StringComparison.Ordinal)) throw new InvalidOperationException("Definition readback mismatch.");
        }
    }
}

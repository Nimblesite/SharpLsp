using System.Xml.Linq;
using XmlReadResult = Outcome.Result<System.Xml.Linq.XDocument, System.Exception>;

namespace SharpLsp.Sidecar.Common;

/// <summary>Read completed project metadata without blocking editor saves. [DIAG-LSP-REFRESH]</summary>
public static class ProjectXml
{
    /// <summary>Share writes and atomic replacement; parse and I/O failures remain explicit.</summary>
    public static XmlReadResult Read(string path)
    {
        try
        {
            using var input = File.Open(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete
            );
            return new XmlReadResult.Ok<XDocument, Exception>(XDocument.Load(input));
        }
        catch (Exception error)
        {
            return XmlReadResult.Failure(error);
        }
    }
}

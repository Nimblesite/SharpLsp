namespace BlazorApp.Components.Shared;

/// <summary>
/// A plain C# type the fixture's Razor components call into, so that a call from Razor code and
/// markup reaches a method declared outside the projection. [RAZOR-TESTING]
/// </summary>
internal static class Counting
{
    /// <summary>Doubles a count.</summary>
    internal static int Bump(int by)
    {
        return by * 2;
    }
}

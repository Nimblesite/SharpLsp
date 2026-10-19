using Microsoft.AspNetCore.Components;

namespace BlazorApp.Components.Shared;

/// <summary>A small label beside a tally.</summary>
public partial class Badge
{
    /// <summary>The badge's text.</summary>
    [Parameter] public string Text { get; set; } = "";
}

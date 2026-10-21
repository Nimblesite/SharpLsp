using Microsoft.JSInterop;

namespace BlazorApp.Components.Shared;

/// <summary>
/// The code-behind half of <c>Card.razor</c>. Implements [RAZOR-COLLOCATION-JS] for the
/// sidecar's tests: a collocated module import is answered from a code-behind file too.
/// </summary>
public partial class Card
{
    /// <summary>Loads the component's collocated module from a code-behind method.</summary>
    public static ValueTask<IJSObjectReference> LoadAsync(IJSRuntime js)
    {
        return js.InvokeAsync<IJSObjectReference>("import", "./Components/Shared/Card.razor.js");
    }

    /// <summary>Loads whatever module the caller names, which no definition can resolve.</summary>
    public static ValueTask<IJSObjectReference> LoadAnyAsync(IJSRuntime js, string path)
    {
        return js.InvokeAsync<IJSObjectReference>("import", path);
    }

    /// <summary>Runs a JavaScript function; the first argument is not an import.</summary>
    public static ValueTask<bool> InvokeAsync(IJSRuntime js, string identifier)
    {
        return js.InvokeAsync<bool>(identifier, "./Components/Shared/Card.razor.js");
    }
}

using Microsoft.JSInterop;

namespace BlazorApp.Components.Shared;

/// <summary>
/// Loads a component's collocated JavaScript module from plain C#. Implements
/// [RAZOR-COLLOCATION-JS]: the definition of the module a <c>"import"</c> call names is
/// answered from a <c>.cs</c> file as well as from Razor.
/// </summary>
public static class CardInterop
{
    /// <summary>Loads Card's collocated module.</summary>
    public static ValueTask<IJSObjectReference> LoadCardAsync(IJSRuntime js)
    {
        return js.InvokeAsync<IJSObjectReference>("import", "./Components/Shared/Card.razor.js");
    }
}

/**
 * The collocated JavaScript module of Card.razor, imported by
 * `JS.InvokeAsync<IJSObjectReference>("import", "./Components/Shared/Card.razor.js")`.
 */
export function render(elementId) {
  const card = document.getElementById(elementId);
  if (card) {
    card.dataset.enhanced = "true";
  }
}

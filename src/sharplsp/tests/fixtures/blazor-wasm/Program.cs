using BlazorWasmApp;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

// The template's entry point: build the WebAssembly host in the browser, then let it
// take over the page. [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM]
var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

await builder.Build().RunAsync();

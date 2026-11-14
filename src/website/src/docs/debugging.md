---
layout: layouts/docs.njk
title: "Debug C# and F# together"
description: "Step from C# into F# in one VS Code debugging session with SharpLsp."
---

# Debug C# and F# together

Start in a C# console app, step into its F# library and return to the caller in the same session. The film uses .NET 10 and shows the actual VS Code debugger.

{% video "debugging" %}

## Build and launch

Install SharpLsp and the .NET 10 SDK. Open the common parent folder of both projects. Build the C# project, which also builds its referenced F# library.

```sh
dotnet build Checkout/Checkout.csproj
```

Add the configuration below to `.vscode/launch.json`. Adjust `program` to your application's Debug assembly. Keep `cwd` at the common solution root so Just My Code includes both languages.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "C# + F# checkout",
      "type": "sharplsp-coreclr",
      "request": "launch",
      "program": "${workspaceFolder}/Checkout/bin/Debug/net10.0/Checkout.dll",
      "cwd": "${workspaceFolder}",
      "console": "internalConsole",
      "justMyCode": true,
      "stopAtEntry": false
    }
  ]
}
```

## Follow the call

1. Open the C# caller and press **F9** on the call into F#.
2. Press **F5**. At the breakpoint, expand **Variables > Locals** and add an expression under **Watch**.
3. Press **F11** to step into the F# function. The call stack shows the F# frame above its C# caller.
4. Press **F10** to execute each statement and inspect bindings after their definitions.
5. Press **Shift+F11** to return to C#. Press F10 if the assignment has not completed, then F5 to finish.

The sample calculates `3 * 20 - 5` and prints `Total: 55`. Function keys may require Fn on your keyboard. The Command Palette provides the same debugger actions.

## If a breakpoint does not stop

Rebuild in Debug and keep the `.pdb` files beside the assemblies. Open the real solution directory if a symbolic link changes source paths. Confirm the yellow execution line and paused call-stack status.

The film was recorded with a local SharpLsp build. Its [runnable sample and recording notes](https://github.com/MelbourneDeveloper/Videos/tree/feat/deslop-narrated-demo/projects/sharplsp/videos/debugging) are available in the video repository.

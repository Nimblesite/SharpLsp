import * as assert from "node:assert/strict";
import { ForgeStatusBar, ServerState } from "../../status.js";

suite("ForgeStatusBar — Construction", () => {
  let statusBar: ForgeStatusBar;

  setup(() => {
    statusBar = new ForgeStatusBar();
  });

  teardown(() => {
    statusBar.dispose();
  });

  test("constructor creates a status bar item", () => {
    assert.ok(statusBar, "ForgeStatusBar should be constructable");
  });

  test("constructor does not throw", () => {
    assert.doesNotThrow(() => {
      const sb = new ForgeStatusBar();
      sb.dispose();
    });
  });

  test("multiple instances can coexist", () => {
    const second = new ForgeStatusBar();
    assert.ok(second, "Second instance should be constructable");
    second.dispose();
  });
});

suite("ForgeStatusBar — setState() State Transitions", () => {
  let statusBar: ForgeStatusBar;

  setup(() => {
    statusBar = new ForgeStatusBar();
  });

  teardown(() => {
    statusBar.dispose();
  });

  test("setState(Starting) does not throw", () => {
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Starting);
    });
  });

  test("setState(Starting) can be called from initial state", () => {
    statusBar.setState(ServerState.Starting);
    assert.ok(true, "No exception");
  });

  test("setState(Running) does not throw", () => {
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Running);
    });
  });

  test("transition Starting → Running does not throw", () => {
    statusBar.setState(ServerState.Starting);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Running);
    });
  });

  test("setState(Stopped) does not throw", () => {
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Stopped);
    });
  });

  test("transition Running → Stopped does not throw", () => {
    statusBar.setState(ServerState.Running);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Stopped);
    });
  });

  test("setState(Error) does not throw", () => {
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Error);
    });
  });

  test("transition Starting → Error does not throw", () => {
    statusBar.setState(ServerState.Starting);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Error);
    });
  });

  test("transition Running → Error does not throw", () => {
    statusBar.setState(ServerState.Running);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Error);
    });
  });

  test("transition Error → Starting does not throw (recovery)", () => {
    statusBar.setState(ServerState.Error);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Starting);
    });
  });

  test("all forward transitions work: Starting → Running → Stopped", () => {
    statusBar.setState(ServerState.Starting);
    statusBar.setState(ServerState.Running);
    statusBar.setState(ServerState.Stopped);
    assert.ok(true, "Forward transitions completed");
  });

  test("full cycle: Starting → Running → Stopped → Starting → Running", () => {
    statusBar.setState(ServerState.Starting);
    statusBar.setState(ServerState.Running);
    statusBar.setState(ServerState.Stopped);
    statusBar.setState(ServerState.Starting);
    statusBar.setState(ServerState.Running);
    assert.ok(true, "Full cycle completed");
  });

  test("error recovery cycle: Starting → Error → Starting → Running", () => {
    statusBar.setState(ServerState.Starting);
    statusBar.setState(ServerState.Error);
    statusBar.setState(ServerState.Starting);
    statusBar.setState(ServerState.Running);
    assert.ok(true, "Error recovery cycle completed");
  });

  test("rapid state changes do not throw", () => {
    const states = [
      ServerState.Starting,
      ServerState.Running,
      ServerState.Stopped,
      ServerState.Error,
    ];
    assert.doesNotThrow(() => {
      for (let i = 0; i < 50; i++) {
        statusBar.setState(states[i % states.length]!);
      }
    });
  });

  test("setting the same state twice does not throw", () => {
    statusBar.setState(ServerState.Running);
    assert.doesNotThrow(() => {
      statusBar.setState(ServerState.Running);
    });
  });
});

suite("ForgeStatusBar — ServerState Enum Values", () => {
  test("ServerState.Starting is 'starting'", () => {
    assert.strictEqual(ServerState.Starting, "starting");
  });

  test("ServerState.Running is 'running'", () => {
    assert.strictEqual(ServerState.Running, "running");
  });

  test("ServerState.Stopped is 'stopped'", () => {
    assert.strictEqual(ServerState.Stopped, "stopped");
  });

  test("ServerState.Error is 'error'", () => {
    assert.strictEqual(ServerState.Error, "error");
  });
});

suite("ForgeStatusBar — dispose()", () => {
  test("dispose() does not throw", () => {
    const sb = new ForgeStatusBar();
    assert.doesNotThrow(() => {
      sb.dispose();
    });
  });

  test("dispose() can be called after setState", () => {
    const sb = new ForgeStatusBar();
    sb.setState(ServerState.Running);
    assert.doesNotThrow(() => {
      sb.dispose();
    });
  });

  test("dispose() after Error state does not throw", () => {
    const sb = new ForgeStatusBar();
    sb.setState(ServerState.Error);
    assert.doesNotThrow(() => {
      sb.dispose();
    });
  });
});

import * as assert from "node:assert/strict";
import * as log from "../../log";
import { OUTPUT_CHANNEL_NAME, TRACE_CHANNEL_NAME } from "../../constants";

suite("Log Module — Output Channels", () => {
  // We must be careful: the extension may have already created channels.
  // After each test, dispose to reset state for the next test.

  teardown(() => {
    log.dispose();
  });

  // ── output() ─────────────────────────────────────────────────

  test("output() returns an OutputChannel", () => {
    const channel = log.output();
    assert.ok(channel, "Must return an output channel");
    assert.ok(typeof channel.appendLine === "function", "Must have appendLine");
    assert.ok(typeof channel.dispose === "function", "Must have dispose");
  });

  test("output() returns the same instance on repeated calls (lazy singleton)", () => {
    const first = log.output();
    const second = log.output();
    assert.strictEqual(
      first,
      second,
      "Must return the same channel instance",
    );
  });

  test("output() channel has the correct name", () => {
    const channel = log.output();
    assert.strictEqual(
      channel.name,
      OUTPUT_CHANNEL_NAME,
      `Channel name must be '${OUTPUT_CHANNEL_NAME}'`,
    );
  });

  test("output() creates a new instance after dispose()", () => {
    log.output(); // Create initial channel.
    log.dispose();
    const recreated = log.output();
    // After dispose, a new channel should be created.
    assert.ok(recreated, "Must create a new channel after dispose");
    assert.strictEqual(recreated.name, OUTPUT_CHANNEL_NAME);
  });

  // ── trace() ──────────────────────────────────────────────────

  test("trace() returns an OutputChannel", () => {
    const channel = log.trace();
    assert.ok(channel, "Must return an output channel");
    assert.ok(typeof channel.appendLine === "function", "Must have appendLine");
    assert.ok(typeof channel.dispose === "function", "Must have dispose");
  });

  test("trace() returns the same instance on repeated calls (lazy singleton)", () => {
    const first = log.trace();
    const second = log.trace();
    assert.strictEqual(
      first,
      second,
      "Must return the same channel instance",
    );
  });

  test("trace() channel has the correct name", () => {
    const channel = log.trace();
    assert.strictEqual(
      channel.name,
      TRACE_CHANNEL_NAME,
      `Channel name must be '${TRACE_CHANNEL_NAME}'`,
    );
  });

  test("trace() creates a new instance after dispose()", () => {
    log.trace(); // Create initial channel.
    log.dispose();
    const recreated = log.trace();
    assert.ok(recreated, "Must create a new channel after dispose");
    assert.strictEqual(recreated.name, TRACE_CHANNEL_NAME);
  });

  // ── output() and trace() are distinct ────────────────────────

  test("output() and trace() return different channels", () => {
    const out = log.output();
    const tr = log.trace();
    assert.notStrictEqual(out, tr, "Output and trace must be distinct");
    assert.notStrictEqual(
      out.name,
      tr.name,
      "Channel names must differ",
    );
  });

  // ── info() ───────────────────────────────────────────────────

  test("info() does not throw", () => {
    assert.doesNotThrow(() => {
      log.info("test message");
    });
  });

  test("info() can be called with an empty string", () => {
    assert.doesNotThrow(() => {
      log.info("");
    });
  });

  test("info() can be called with a long message", () => {
    const longMessage = "x".repeat(10_000);
    assert.doesNotThrow(() => {
      log.info(longMessage);
    });
  });

  test("info() can be called with special characters", () => {
    assert.doesNotThrow(() => {
      log.info("Special chars: ñ é ü ö — 日本語 中文 🔥");
    });
  });

  test("info() can be called multiple times in succession", () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 100; i++) {
        log.info(`Message ${i}`);
      }
    });
  });

  test("info() writes to the output channel (does not throw after output() is called)", () => {
    const channel = log.output();
    assert.ok(channel, "Channel must exist before info()");
    assert.doesNotThrow(() => {
      log.info("after explicit output() call");
    });
  });

  // ── dispose() ────────────────────────────────────────────────

  test("dispose() does not throw when no channels exist", () => {
    // Fresh state — nothing to dispose.
    log.dispose();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test("dispose() does not throw when only output channel exists", () => {
    log.output(); // Create only the output channel.
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test("dispose() does not throw when only trace channel exists", () => {
    log.trace(); // Create only the trace channel.
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test("dispose() does not throw when both channels exist", () => {
    log.output();
    log.trace();
    assert.doesNotThrow(() => {
      log.dispose();
    });
  });

  test("dispose() can be called multiple times safely (idempotent)", () => {
    log.output();
    log.trace();
    log.dispose();
    log.dispose();
    log.dispose();
    // If we get here without throwing, it's idempotent.
    assert.ok(true, "Multiple dispose() calls should not throw");
  });

  test("info() works after dispose() and re-creation", () => {
    log.info("before dispose");
    log.dispose();
    // After dispose, info() should lazily re-create the output channel.
    assert.doesNotThrow(() => {
      log.info("after dispose and re-creation");
    });
  });
});

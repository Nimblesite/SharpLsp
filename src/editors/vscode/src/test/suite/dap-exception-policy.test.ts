// Implements [CONFIG-DEBUG-EXCEPTIONS].
import * as assert from 'node:assert/strict';
import { withExceptionPolicy } from '../../dap-exception-policy';
import type { DapMessage } from '../../dap-emulate';

suite('Shared exception policy', () => {
  test('multiple excluded types use one negation for the whole native filter', () => {
    const result = withExceptionPolicy(
      { command: 'setExceptionBreakpoints', arguments: { filters: ['all'] } },
      { ignore: ['System.FormatException', 'System.OtherException'] },
    );
    assert.deepEqual(result.arguments, {
      filters: [],
      filterOptions: [
        { filterId: 'all', condition: '!System.FormatException System.OtherException' },
      ],
    });
  });
  const request: DapMessage = {
    seq: 7,
    type: 'request',
    command: 'setExceptionBreakpoints',
    arguments: { filters: ['all'], filterOptions: [] },
  };

  test('exclusions replace the bare all filter and retain DAP request identity', () => {
    const result = withExceptionPolicy(request, {
      break_on: 'all',
      ignore: ['System.FormatException'],
    });
    assert.deepEqual(result.arguments, {
      filters: [],
      filterOptions: [{ filterId: 'all', condition: '!System.FormatException' }],
    });
    assert.equal(result.seq, request.seq);
    assert.deepEqual(request.arguments, { filters: ['all'], filterOptions: [] });
    assert.deepEqual(
      withExceptionPolicy(result, { break_on: 'all', ignore: ['System.FormatException'] }),
      result,
    );
  });

  test('user boundary and terminal-only modes do not accidentally enable all throws', () => {
    assert.deepEqual(withExceptionPolicy(request, { break_on: 'user-unhandled' }).arguments, {
      filters: [],
      filterOptions: [{ filterId: 'user-unhandled', condition: '' }],
    });
    assert.deepEqual(withExceptionPolicy(request, { break_on: 'unhandled' }).arguments, {
      filters: [],
      filterOptions: [],
    });
    assert.equal(withExceptionPolicy(request, undefined), request);
  });

  test('ignoring the only selected type disables that filter instead of matching every type', () => {
    const typed = {
      ...request,
      arguments: {
        filters: [],
        filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }],
      },
    };
    assert.deepEqual(withExceptionPolicy(typed, { ignore: ['System.FormatException'] }).arguments, {
      filters: [],
      filterOptions: [],
    });
    assert.deepEqual(withExceptionPolicy(typed, { ignore: ['System.OtherException'] }).arguments, {
      filters: [],
      filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }],
    });
  });
  test('client filters and filterOptions remain additive when exclusions are applied', () => {
    const result = withExceptionPolicy(
      {
        command: 'setExceptionBreakpoints',
        arguments: {
          filters: ['all'],
          filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }],
        },
      },
      { ignore: ['System.OtherException'] },
    );
    assert.deepEqual(result.arguments, {
      filters: [],
      filterOptions: [
        { filterId: 'all', condition: 'System.FormatException' },
        { filterId: 'all', condition: '!System.OtherException' },
      ],
    });
  });
});

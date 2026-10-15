// Tests [PROFILER-SHARED-LIBRARY-VSCODE]: the host imports ESM, the compiled UI requires CJS.
import { signal } from '@preact/signals-core';
const { effect } = require('@preact/signals-core');
const state = signal(0);
const observed = [];
const dispose = effect(() => { observed.push(state.value); });
state.value = 1;
state.value = 2;
dispose();
state.value = 3;
module.exports = observed;

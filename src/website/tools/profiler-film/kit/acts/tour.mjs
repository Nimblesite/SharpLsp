// Implements [WEB-DESIGN-MEDIA]. The profiler tour a language's profiler film
// tells: Profile CPU on a running demo and read the heat on `cpu.file`, then
// the whole memory loop on `memory.file`, numbered on from the CPU steps.
import { prepare, switchTo } from '../scenes.mjs';
import { cpuLoop } from './cpu.mjs';
import { memoryLoop } from './memory.mjs';

const CPU_STEPS = 3;

/** The tour's scenes: `cpu` and `memory` are cpuLoop's and memoryLoop's stories. */
export const profilerTour = (cpu, memory) => [
  { offCamera: prepare(cpu.file) },
  ...cpuLoop(cpu, 1),
  { offCamera: switchTo(memory.file) },
  ...memoryLoop(memory, CPU_STEPS + 1),
];

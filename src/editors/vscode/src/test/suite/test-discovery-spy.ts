import type { SharpLspTestController } from '../../testing.js';

export interface DiscoverSpy {
  readonly stacks: string[];
  readonly modes: boolean[];
  restore: () => void;
}

/** Observe real discovery calls while preserving their build mode and work. */
export function spyOnDiscover(controller: SharpLspTestController): DiscoverSpy {
  const stacks: string[] = [];
  const modes: boolean[] = [];
  const original = controller.discover.bind(controller);
  controller.discover = async (noBuild?: boolean): Promise<void> => {
    const trace = (new Error('discover').stack ?? '<no stack>').split('\n');
    stacks.push(trace.slice(2).join('\n'));
    modes.push(noBuild === true);
    await original(noBuild);
  };
  return {
    stacks,
    modes,
    restore: (): void => {
      Reflect.deleteProperty(controller, 'discover');
    },
  };
}

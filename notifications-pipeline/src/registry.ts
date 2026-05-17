import type { EngineFactory, EngineId } from './engine';
import { effectorFactory } from './engines/effector';
import { nakedFactory } from './engines/naked';
import { reatomFactory } from './engines/reatom';
import { rtkListenerFactory } from './engines/rtk-listener';
import { rxjsFactory } from './engines/rxjs';
import { triggeryFactory } from './engines/triggery';

export const ENGINES: Record<EngineId, EngineFactory> = {
  triggery: triggeryFactory,
  effector: effectorFactory,
  rxjs: rxjsFactory,
  reatom: reatomFactory,
  rtk: rtkListenerFactory,
  naked: nakedFactory,
};

export const ENGINE_LIST: readonly EngineFactory[] = [
  triggeryFactory,
  effectorFactory,
  rxjsFactory,
  reatomFactory,
  rtkListenerFactory,
  nakedFactory,
];

export function resolveEngineId(raw: string | null | undefined): EngineId {
  const id = (raw ?? '').toLowerCase();
  return id in ENGINES ? (id as EngineId) : 'triggery';
}

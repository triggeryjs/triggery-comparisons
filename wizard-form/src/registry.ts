import type { EngineFactory, EngineId } from './engine';
import { effectorFactory } from './engines/effector';
import { nakedFactory } from './engines/naked';
import { reatomFactory } from './engines/reatom';
import { reduxSagaFactory } from './engines/redux-saga';
import { reduxThunkFactory } from './engines/redux-thunk';
import { rtkListenerFactory } from './engines/rtk-listener';
import { rxjsFactory } from './engines/rxjs';
import { triggeryFactory } from './engines/triggery';
import { xstateFactory } from './engines/xstate';

export const ENGINES: Record<EngineId, EngineFactory> = {
  triggery: triggeryFactory,
  xstate: xstateFactory,
  effector: effectorFactory,
  rxjs: rxjsFactory,
  reatom: reatomFactory,
  rtk: rtkListenerFactory,
  'redux-thunk': reduxThunkFactory,
  'redux-saga': reduxSagaFactory,
  naked: nakedFactory,
};

export const ENGINE_LIST: readonly EngineFactory[] = [
  triggeryFactory,
  xstateFactory,
  effectorFactory,
  rxjsFactory,
  reatomFactory,
  rtkListenerFactory,
  reduxThunkFactory,
  reduxSagaFactory,
  nakedFactory,
];

export function resolveEngineId(raw: string | null | undefined): EngineId {
  const id = (raw ?? '').toLowerCase();
  return id in ENGINES ? (id as EngineId) : 'triggery';
}

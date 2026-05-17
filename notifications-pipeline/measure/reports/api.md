## API surface — what each engine imports from its library

| engine       | imports | symbols | primitives | concepts list |
|--------------|---:|---:|---:|---|
| naked        |       0 |       0 |          7 | emitter×7 |
| triggery     |       1 |       2 |          3 | createTrigger×2, createRuntime×1 |
| reatom       |       1 |       3 |         17 | atom×5, action×11, createCtx×1 |
| effector     |       1 |       5 |         35 | createEvent×15, createStore×7, createEffect×3, sample×9, combine×1 |
| rtk-listener |       1 |       5 |         23 | createAction×11, createSlice×1, createListenerMiddleware×1, startListening×10 |
| rxjs         |       1 |      15 |         26 | Subject×10, BehaviorSubject×5, .pipe(×11 |

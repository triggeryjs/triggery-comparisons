## API surface — what each engine imports from its library

| engine       | imports | symbols | primitives | concepts list |
|--------------|---:|---:|---:|---|
| naked        |       0 |       0 |          0 |  |
| triggery     |       1 |       2 |          2 | createTrigger×1, createRuntime×1 |
| reatom       |       1 |       3 |         13 | atom×6, action×6, createCtx×1 |
| effector     |       1 |       5 |         25 | createEvent×11, createStore×5, createEffect×2, sample×6, combine×1 |
| redux-thunk  |       1 |       5 |          1 | createSlice×1 |
| rtk-listener |       1 |       5 |          7 | createAction×1, createSlice×1, createListenerMiddleware×1, startListening×4 |
| xstate       |       1 |       7 |          0 |  |
| redux-saga   |       3 |      11 |          1 | createSlice×1 |
| rxjs         |       2 |      18 |         15 | Subject×1, BehaviorSubject×1, .pipe(×13 |

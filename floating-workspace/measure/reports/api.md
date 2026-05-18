## API surface — what each engine imports from its library

| engine       | imports | symbols | primitives | concepts list |
|--------------|---:|---:|---:|---|
| naked        |       0 |       0 |          0 |  |
| _redux-slice |       1 |       2 |          1 | createSlice×1 |
| effector     |       1 |       2 |         26 | createEvent×25, createStore×1 |
| triggery     |       1 |       2 |          2 | createTrigger×1, createRuntime×1 |
| reatom       |       1 |       3 |          3 | atom×1, action×1, createCtx×1 |
| redux-thunk  |       1 |       3 |          0 |  |
| rtk-listener |       1 |       3 |          2 | createAction×1, createListenerMiddleware×1 |
| xstate       |       1 |       6 |          0 |  |
| redux-saga   |       3 |       9 |          1 | createAction×1 |
| rxjs         |       2 |      12 |          7 | Subject×2, BehaviorSubject×1, .pipe(×4 |

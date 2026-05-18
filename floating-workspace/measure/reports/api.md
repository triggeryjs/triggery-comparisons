## API surface — what each engine imports from its library

| engine       | imports | symbols | primitives | concepts list |
|--------------|---:|---:|---:|---|
| naked        |       0 |       0 |          0 |  |
| effector     |       1 |       2 |         13 | createEvent×12, createStore×1 |
| triggery     |       1 |       2 |          5 | createTrigger×4, createRuntime×1 |
| reatom       |       1 |       3 |          3 | atom×1, action×1, createCtx×1 |
| redux-thunk  |       1 |       5 |          1 | createSlice×1 |
| rtk-listener |       1 |       5 |          5 | createAction×1, createSlice×1, createListenerMiddleware×1, startListening×2 |
| xstate       |       1 |       6 |          0 |  |
| redux-saga   |       3 |      12 |          2 | createAction×1, createSlice×1 |
| rxjs         |       2 |      13 |          9 | Subject×1, BehaviorSubject×1, .pipe(×7 |

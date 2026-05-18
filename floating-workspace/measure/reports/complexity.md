## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rtk-listener |    57 |       6 |  5 |  0 |
| redux-saga   |    57 |       6 |  6 |  0 |
| effector     |    61 |       7 |  1 |  0 |
| reatom       |    62 |       8 |  1 |  0 |
| redux-thunk  |    62 |       6 |  4 |  0 |
| naked        |    64 |       7 |  1 |  0 |
| triggery     |    68 |       7 |  3 |  0 |
| rxjs         |    73 |       7 |  1 |  0 |
| xstate       |    74 |       8 |  4 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

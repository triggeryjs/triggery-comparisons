## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rtk-listener |    17 |       6 | 11 |  0 |
| redux-saga   |    17 |       6 |  7 |  0 |
| xstate       |    20 |       8 |  4 |  0 |
| naked        |    22 |       7 |  1 |  0 |
| reatom       |    22 |       6 |  1 |  0 |
| redux-thunk  |    24 |       6 |  4 |  0 |
| effector     |    25 |       6 | 11 |  0 |
| rxjs         |    26 |       7 |  3 |  0 |
| triggery     |    29 |       9 |  3 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

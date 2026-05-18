## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| redux-saga   |    32 |       6 |  1 |  0 |
| rtk-listener |    33 |       7 |  1 |  0 |
| redux-thunk  |    36 |       6 |  1 |  0 |
| _redux-slice |    65 |       5 |  1 |  3 |
| triggery     |    88 |       8 |  2 |  4 |
| xstate       |    92 |      11 |  1 |  3 |
| naked        |    94 |       8 |  1 |  4 |
| effector     |    94 |       7 |  1 |  3 |
| reatom       |    94 |       9 |  1 |  3 |
| rxjs         |   116 |       7 |  1 |  3 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

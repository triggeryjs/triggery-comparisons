## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| redux-saga   |    32 |       6 |  1 |  0 |
| rtk-listener |    33 |       7 |  1 |  0 |
| redux-thunk  |    36 |       6 |  1 |  0 |
| _redux-slice |    65 |       5 |  2 |  3 |
| xstate       |    92 |      11 |  2 |  3 |
| triggery     |    93 |       9 |  4 |  3 |
| naked        |    94 |       8 |  1 |  4 |
| effector     |    94 |       7 |  2 |  3 |
| reatom       |    94 |       9 |  2 |  3 |
| rxjs         |   116 |       7 |  2 |  3 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

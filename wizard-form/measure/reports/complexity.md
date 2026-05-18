## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rtk-listener |    30 |       6 | 18 |  0 |
| redux-saga   |    30 |       6 |  7 |  0 |
| naked        |    36 |       7 |  1 |  0 |
| reatom       |    36 |       7 |  1 |  0 |
| xstate       |    36 |       8 |  4 |  0 |
| rxjs         |    37 |       7 |  5 |  0 |
| effector     |    38 |       6 | 10 |  0 |
| redux-thunk  |    43 |       7 |  4 |  0 |
| triggery     |    46 |       9 |  3 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

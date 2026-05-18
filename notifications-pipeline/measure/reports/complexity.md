## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rxjs         |    24 |       6 |  0 |  0 |
| rtk-listener |    25 |       7 |  1 |  0 |
| triggery     |    26 |       6 |  0 |  0 |
| naked        |    29 |       7 |  0 |  0 |
| effector     |    29 |       5 |  0 |  2 |
| redux-saga   |    30 |       6 |  7 |  0 |
| redux-thunk  |    33 |       6 |  2 |  0 |
| reatom       |    35 |       6 |  0 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

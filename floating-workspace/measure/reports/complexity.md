## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rtk-listener |    37 |       6 |  4 |  0 |
| redux-saga   |    37 |       6 |  5 |  0 |
| effector     |    42 |       7 |  1 |  0 |
| redux-thunk  |    42 |       6 |  3 |  0 |
| reatom       |    43 |       8 |  1 |  0 |
| naked        |    44 |       7 |  1 |  0 |
| triggery     |    48 |       7 |  3 |  0 |
| rxjs         |    51 |       7 |  1 |  0 |
| xstate       |    52 |       8 |  4 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

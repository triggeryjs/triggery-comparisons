## Complexity & type safety

| engine       | cyclo | nesting | as | ! |
|--------------|---:|---:|---:|---:|
| rxjs         |    21 |       6 |  0 |  0 |
| triggery     |    24 |       6 |  0 |  1 |
| rtk-listener |    24 |       7 |  1 |  0 |
| effector     |    26 |       5 |  0 |  2 |
| naked        |    28 |       7 |  0 |  0 |
| reatom       |    33 |       6 |  0 |  0 |

- **cyclo**: rough cyclomatic count (if/for/while/case/catch/&&/||/?: + 1).
- **nesting**: deepest brace nesting in the file.
- **as**: \`as TypeName\` casts (excluding \`as const\`).
- **!**: non-null assertions \`x!\`.

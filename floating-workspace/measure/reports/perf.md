| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Naked baseline         |   9070k ev/sec |       3 |  0.54 µs |  0.67 µs |   2.6 µs |
| Redux + thunk          |   7190k ev/sec |       3 |   4.0 µs |   5.5 µs |    17 µs |
| Reatom                 |   4709k ev/sec |       3 |   2.5 µs |   3.0 µs |    12 µs |
| Effector               |   4597k ev/sec |       3 |   3.5 µs |   6.6 µs |    26 µs |
| Triggery               |   1953k ev/sec |       3 |   3.1 µs |   4.0 µs |    11 µs |
| RxJS                   |   1779k ev/sec |       3 |  0.96 µs |   1.1 µs |   5.8 µs |
| Redux + saga           |    578k ev/sec |    1007 |   3.4 µs |    14 µs |    18 µs |
| XState                 |    118k ev/sec |    1002 |   5.7 µs |   8.8 µs |    22 µs |
| RTK listenerMiddleware |     37k ev/sec |    1003 |   7.9 µs |    18 µs |    44 µs |

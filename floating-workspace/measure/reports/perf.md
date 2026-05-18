| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Naked baseline         |  11407k ev/sec |       3 |  0.63 µs |  0.71 µs |   2.3 µs |
| Redux + thunk          |   7621k ev/sec |       3 |   4.2 µs |    13 µs |    33 µs |
| Effector               |   6861k ev/sec |       3 |   3.1 µs |   6.2 µs |    18 µs |
| Reatom                 |   4854k ev/sec |       3 |   2.4 µs |   3.5 µs |   9.8 µs |
| RxJS                   |   1651k ev/sec |       3 |   1.0 µs |   1.4 µs |   5.7 µs |
| Redux + saga           |    722k ev/sec |       3 |   3.4 µs |    12 µs |    31 µs |
| Triggery               |    339k ev/sec |       3 |   2.5 µs |   3.5 µs |   9.3 µs |
| XState                 |    100k ev/sec |    1002 |   4.4 µs |   6.9 µs |    21 µs |
| RTK listenerMiddleware |     71k ev/sec |       2 |   6.5 µs |    11 µs |    23 µs |

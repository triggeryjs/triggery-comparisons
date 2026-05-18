| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Redux + thunk          |   7813k ev/sec |       3 |   4.5 µs |   5.7 µs |    16 µs |
| Reatom                 |   4296k ev/sec |       3 |   2.5 µs |   3.9 µs |   9.4 µs |
| Effector               |   3502k ev/sec |       3 |   4.6 µs |   9.1 µs |    16 µs |
| Naked baseline         |   2814k ev/sec |       3 |  0.67 µs |  0.75 µs |   2.2 µs |
| RxJS                   |   1815k ev/sec |       3 |   1.1 µs |   1.9 µs |   5.4 µs |
| Triggery               |    231k ev/sec |       3 |   2.5 µs |   4.6 µs |    12 µs |
| Redux + saga           |    217k ev/sec |       3 |   4.4 µs |    26 µs |    46 µs |
| XState                 |     87k ev/sec |    1002 |   4.7 µs |    19 µs |    57 µs |
| RTK listenerMiddleware |     75k ev/sec |       2 |   6.7 µs |    10 µs |    31 µs |

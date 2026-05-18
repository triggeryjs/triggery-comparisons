| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Naked baseline         |  10526k ev/sec |       3 |  0.58 µs |  0.63 µs |   1.6 µs |
| Redux + thunk          |   7724k ev/sec |       3 |   4.2 µs |   5.5 µs |    14 µs |
| Effector               |   4619k ev/sec |       3 |   4.0 µs |   8.4 µs |    24 µs |
| Reatom                 |   3344k ev/sec |       3 |   2.4 µs |   3.0 µs |    10 µs |
| RxJS                   |   2724k ev/sec |       3 |  0.92 µs |   1.1 µs |   6.0 µs |
| Triggery               |   2066k ev/sec |       3 |   3.1 µs |   4.1 µs |   9.2 µs |
| Redux + saga           |    389k ev/sec |    1007 |   3.4 µs |   4.7 µs |    14 µs |
| XState                 |    124k ev/sec |    1002 |   6.6 µs |    10 µs |    41 µs |
| RTK listenerMiddleware |     39k ev/sec |    1003 |   7.8 µs |    13 µs |    37 µs |

| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Naked baseline         |   7797k ev/sec |       3 |  0.67 µs |  0.75 µs |   1.9 µs |
| Redux + thunk          |   4938k ev/sec |       3 |   4.2 µs |   6.8 µs |    25 µs |
| Reatom                 |   4766k ev/sec |       3 |   2.4 µs |   3.2 µs |    11 µs |
| Effector               |   4349k ev/sec |       3 |   3.6 µs |    16 µs |    39 µs |
| RxJS                   |   2300k ev/sec |       3 |  0.96 µs |   1.1 µs |   4.6 µs |
| Redux + saga           |    345k ev/sec |    1007 |   3.5 µs |    16 µs |    67 µs |
| Triggery               |    269k ev/sec |       3 |   2.7 µs |   4.5 µs |    27 µs |
| XState                 |     84k ev/sec |    1002 |   4.5 µs |   6.8 µs |    25 µs |
| RTK listenerMiddleware |     25k ev/sec |    1004 |   7.6 µs |    14 µs |    47 µs |

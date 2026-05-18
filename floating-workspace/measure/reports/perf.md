| engine                 | drag events/sec | snapshots/1000 | setBody p50 | p95 | p99 |
|------------------------|---:|---:|---:|---:|---:|
| Naked baseline         |  10845k ev/sec |       3 |  0.54 µs |  0.71 µs |   3.5 µs |
| Redux + thunk          |   7357k ev/sec |       3 |   3.8 µs |   5.0 µs |    13 µs |
| Effector               |   5091k ev/sec |       3 |   3.5 µs |   6.6 µs |    31 µs |
| Reatom                 |   4511k ev/sec |       3 |   2.4 µs |   3.5 µs |   7.7 µs |
| Triggery               |   2262k ev/sec |       3 |   3.0 µs |   4.1 µs |    13 µs |
| RxJS                   |   2167k ev/sec |       3 |  0.96 µs |   2.2 µs |   4.0 µs |
| Redux + saga           |    649k ev/sec |    1007 |   3.3 µs |    15 µs |    38 µs |
| XState                 |    103k ev/sec |    1002 |   5.7 µs |    12 µs |    51 µs |
| RTK listenerMiddleware |     36k ev/sec |    1003 |   8.0 µs |    12 µs |    26 µs |

| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked baseline         | 1570k ops/sec |  0.42 µs |  0.46 µs |  0.54 µs |
| RxJS                   |  276k ops/sec |   2.3 µs |   2.5 µs |   6.7 µs |
| Reatom                 |  211k ops/sec |   2.1 µs |   2.7 µs |   5.9 µs |
| Triggery               |  206k ops/sec |   2.6 µs |   3.2 µs |   7.0 µs |
| Redux + thunk          |   84k ops/sec |   9.4 µs |    10 µs |    23 µs |
| XState                 |   65k ops/sec |   6.3 µs |   8.9 µs |    27 µs |
| Effector               |   51k ops/sec |   6.0 µs |   7.6 µs |    16 µs |
| Redux + saga           |   51k ops/sec |   9.7 µs |    11 µs |    26 µs |
| RTK listenerMiddleware |   32k ops/sec |    11 µs |    12 µs |    31 µs |

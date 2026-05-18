| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked baseline         | 1747k ops/sec |  0.46 µs |  0.50 µs |  0.58 µs |
| RxJS                   |  358k ops/sec |   2.2 µs |   2.3 µs |   3.1 µs |
| Reatom                 |  275k ops/sec |   2.1 µs |   2.8 µs |   7.2 µs |
| Triggery               |  177k ops/sec |   2.5 µs |   3.2 µs |   7.1 µs |
| Redux + thunk          |   85k ops/sec |   9.4 µs |    10 µs |    16 µs |
| XState                 |   79k ops/sec |   6.5 µs |   9.7 µs |    20 µs |
| Redux + saga           |   64k ops/sec |   9.7 µs |    11 µs |    14 µs |
| Effector               |   64k ops/sec |   5.9 µs |   6.8 µs |    14 µs |
| RTK listenerMiddleware |   35k ops/sec |    11 µs |    12 µs |    21 µs |

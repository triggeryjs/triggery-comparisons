| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked baseline         | 1111k ops/sec |  0.46 µs |  0.50 µs |  0.71 µs |
| RxJS                   |  306k ops/sec |   2.3 µs |   2.5 µs |   3.5 µs |
| Reatom                 |  221k ops/sec |   2.1 µs |   3.0 µs |    13 µs |
| Triggery               |  180k ops/sec |   2.5 µs |   3.2 µs |   6.5 µs |
| Redux + thunk          |   91k ops/sec |   9.5 µs |    11 µs |    30 µs |
| XState                 |   65k ops/sec |   6.6 µs |   9.2 µs |    25 µs |
| Effector               |   64k ops/sec |   5.8 µs |   7.5 µs |    13 µs |
| Redux + saga           |   56k ops/sec |   9.8 µs |    11 µs |    25 µs |
| RTK listenerMiddleware |   33k ops/sec |    11 µs |    12 µs |    27 µs |

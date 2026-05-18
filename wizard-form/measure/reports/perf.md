| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked baseline         |  997k ops/sec |  0.38 µs |  0.46 µs |   1.2 µs |
| RxJS                   |  305k ops/sec |   2.0 µs |   2.1 µs |   2.7 µs |
| Reatom                 |  214k ops/sec |   2.0 µs |    16 µs |    53 µs |
| Triggery               |  205k ops/sec |   2.6 µs |   3.6 µs |    25 µs |
| Redux + thunk          |  100k ops/sec |   7.8 µs |   8.6 µs |    19 µs |
| Redux + saga           |   80k ops/sec |   7.7 µs |   8.5 µs |    12 µs |
| XState                 |   71k ops/sec |   4.3 µs |   6.0 µs |    15 µs |
| Effector               |   61k ops/sec |   6.2 µs |   8.0 µs |    22 µs |
| RTK listenerMiddleware |   20k ops/sec |   9.5 µs |    12 µs |    37 µs |

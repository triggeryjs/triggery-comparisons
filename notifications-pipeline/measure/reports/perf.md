| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  603k ops/sec |  0.13 µs |  0.17 µs |  0.21 µs |
| Triggery (fireSync)    |  275k ops/sec |   1.5 µs |   1.7 µs |   3.7 µs |
| Redux + thunk          |  227k ops/sec |   1.3 µs |   1.8 µs |   7.8 µs |
| RxJS                   |  216k ops/sec |  0.25 µs |  0.33 µs |  0.92 µs |
| Reatom                 |  214k ops/sec |   1.9 µs |   2.8 µs |   3.8 µs |
| Triggery               |  164k ops/sec |   2.8 µs |    10 µs |    51 µs |
| Effector               |  140k ops/sec |   2.7 µs |   6.2 µs |    12 µs |
| RTK listenerMiddleware |   65k ops/sec |   7.0 µs |   8.9 µs |    19 µs |
| Redux + saga           |   57k ops/sec |   6.5 µs |   9.7 µs |    41 µs |

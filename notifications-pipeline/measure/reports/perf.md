| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  632k ops/sec |  0.13 µs |  0.17 µs |  0.33 µs |
| Triggery (fireSync)    |  275k ops/sec |   1.4 µs |   1.7 µs |   2.7 µs |
| Redux + thunk          |  235k ops/sec |   1.4 µs |   2.1 µs |   3.2 µs |
| Reatom                 |  229k ops/sec |   1.9 µs |   2.8 µs |   5.0 µs |
| RxJS                   |  221k ops/sec |  0.25 µs |  0.37 µs |  0.71 µs |
| Effector               |  134k ops/sec |   2.7 µs |   6.0 µs |    11 µs |
| Triggery               |  116k ops/sec |   2.6 µs |   5.3 µs |    16 µs |
| RTK listenerMiddleware |   67k ops/sec |   7.2 µs |   9.2 µs |    23 µs |
| Redux + saga           |   39k ops/sec |   6.2 µs |  10.0 µs |    37 µs |

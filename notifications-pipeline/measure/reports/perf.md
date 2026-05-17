| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| RxJS                   | 1138k ops/sec |  0.25 µs |  0.29 µs |  0.71 µs |
| Naked (no library)     |  752k ops/sec |  0.17 µs |  0.21 µs |  0.46 µs |
| Triggery (fireSync)    |  306k ops/sec |   1.4 µs |   1.6 µs |   2.3 µs |
| Reatom                 |  301k ops/sec |   1.9 µs |   2.1 µs |   3.1 µs |
| Triggery               |  276k ops/sec |   2.5 µs |   3.5 µs |   9.8 µs |
| Effector               |  111k ops/sec |   3.1 µs |   3.7 µs |   7.6 µs |
| RTK listenerMiddleware |   54k ops/sec |   7.3 µs |    10 µs |    22 µs |

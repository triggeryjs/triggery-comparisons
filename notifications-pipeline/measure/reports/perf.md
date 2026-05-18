| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  612k ops/sec |  0.13 µs |  0.17 µs |  0.25 µs |
| Triggery (fireSync)    |  284k ops/sec |   2.4 µs |    20 µs |    41 µs |
| Reatom                 |  246k ops/sec |   1.9 µs |   2.9 µs |   4.0 µs |
| Triggery               |  228k ops/sec |   2.6 µs |   3.8 µs |    11 µs |
| RxJS                   |  183k ops/sec |  0.25 µs |  0.75 µs |   2.0 µs |
| Effector               |  158k ops/sec |   2.7 µs |   5.8 µs |   9.7 µs |
| RTK listenerMiddleware |   67k ops/sec |   6.8 µs |   9.4 µs |    16 µs |

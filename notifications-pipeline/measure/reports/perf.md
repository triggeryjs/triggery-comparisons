| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  655k ops/sec |  0.13 µs |  0.17 µs |  0.25 µs |
| Triggery (fireSync)    |  282k ops/sec |   2.3 µs |    20 µs |    38 µs |
| Reatom                 |  254k ops/sec |   1.9 µs |   2.8 µs |   3.8 µs |
| RxJS                   |  219k ops/sec |  0.21 µs |  0.33 µs |  0.83 µs |
| Triggery               |  185k ops/sec |   2.5 µs |   3.3 µs |   9.3 µs |
| Effector               |  177k ops/sec |   2.6 µs |   5.9 µs |    18 µs |
| RTK listenerMiddleware |   71k ops/sec |   6.9 µs |   8.6 µs |    20 µs |

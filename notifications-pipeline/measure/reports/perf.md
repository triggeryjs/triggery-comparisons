| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  641k ops/sec |  0.13 µs |  0.17 µs |  0.25 µs |
| Redux + thunk          |  256k ops/sec |   1.3 µs |   1.5 µs |   5.8 µs |
| Triggery (fireSync)    |  256k ops/sec |   1.5 µs |   1.8 µs |   2.6 µs |
| Reatom                 |  243k ops/sec |   1.9 µs |   2.8 µs |   4.1 µs |
| RxJS                   |  204k ops/sec |  0.21 µs |  0.29 µs |  0.58 µs |
| Triggery               |  188k ops/sec |   2.7 µs |   4.6 µs |   9.4 µs |
| Effector               |  179k ops/sec |   2.6 µs |   6.0 µs |    13 µs |
| RTK listenerMiddleware |   67k ops/sec |   7.0 µs |   9.5 µs |    20 µs |
| Redux + saga           |   38k ops/sec |   6.3 µs |    10 µs |    33 µs |

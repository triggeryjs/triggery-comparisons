| engine                 | throughput | p50 lat. | p95 lat. | p99 lat. |
|------------------------|---:|---:|---:|---:|
| Naked (no library)     |  649k ops/sec |  0.13 µs |  0.17 µs |  0.21 µs |
| Triggery (fireSync)    |  247k ops/sec |   1.5 µs |   2.0 µs |   5.1 µs |
| Redux + thunk          |  209k ops/sec |   1.3 µs |   1.5 µs |   2.4 µs |
| Reatom                 |  206k ops/sec |   2.0 µs |   3.0 µs |   5.2 µs |
| RxJS                   |  185k ops/sec |  0.25 µs |  0.33 µs |  0.88 µs |
| Effector               |  170k ops/sec |   2.9 µs |   7.6 µs |    23 µs |
| Triggery               |  163k ops/sec |   2.9 µs |   5.2 µs |    16 µs |
| Redux + saga           |   74k ops/sec |   6.2 µs |   7.9 µs |    30 µs |
| RTK listenerMiddleware |   61k ops/sec |   7.1 µs |    11 µs |    48 µs |

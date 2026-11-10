# Interrupted initial capacity search

This attempt tested source commit `4935bc790d1743438756dd25cf808b7a890b5549` with a 256 MiB public-gateway memory limit. The 30-second probes at 5, 10, 20, 40 and 80 requests/second passed the per-category latency, correctness and failure criteria. These short probes do not establish sustained capacity.

At 160 requests/second, the memory guard observed the public gateway near its limit (98.9% during warm-up and 90.78% during the measured attempt) and stopped new load. Tutor CPU reached approximately its 0.5 CPU quota. The measured attempt lasted only about 1.76 seconds and is incomplete. Its broad-query p95 was about 569.5 ms; these few seconds are not a qualified capacity measurement.

The first resource inventory also preceded creation of the load-generator container, so this interrupted attempt has no generator CPU samples. The runner correctly withheld a capacity claim and removed the isolated stack and volumes. The raw artifacts are retained here.

The subsequent experiment uses a fixed 512 MiB gateway budget for both topologies and delays its first resource inventory until after generator startup. It restarts fixture preparation and baseline discovery from a fresh isolated project. See the sibling `discovery-2026-11-11` bundle for that experiment. The service CPU limits and Tutor/Booking/Review per-replica memory limits are unchanged.

Raw outputs are retained in `raw-results.tar.gz`, with per-file checksums in its `RAW_SHA256SUMS`. `SHA256SUMS` verifies the readable files and archive. Extract with `tar -xzf raw-results.tar.gz -C <empty-directory>`.

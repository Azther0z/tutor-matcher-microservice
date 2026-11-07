# Step-3 validation record

Verified locally on 6 November 2026 on the PR branch. Target services were not executed or deployed.
The latest user-confirmed split replaces 18 private domain HTTP operations with gRPC and retains the two availability methods.

| Check | Result |
| --- | --- |
| Shared JSON Schema and references | Pass: 129 shared definitions and 24 gRPC request/availability validation definitions. References resolve locally without fetching schemas. |
| Notification schema | Pass: 21 unchanged typed event variants with producer/category/audience constraints. |
| Combined operation inventory | Pass: 86 public REST, eight private Gateway REST and 20 private gRPC methods. All 114 IDs are unique and every AUTH/UC/SUP behavior ID is covered. |
| REST/event schema cases | Pass: 82 positive/negative cases and nine exact money/time calculation cases. |
| gRPC schema fixtures | Pass: 20 request/response pairs, 40 validated messages, plus 12 invalid-value cases. Batch ordering/windows and identity agreement are checked where applicable. |
| Protobuf compilation/codecs | Pass: seven proto files and 20 unary descriptors resolve. All 40 messages round-trip through protobufjs and through the installed grpc-js serializers. Explicit false/missing presence, enum zero and typed binary error trailers pass. Wire fields/types match schema views. The bounded maximum availability payload fits the declared 32 MiB ceiling. |
| Public REST collection | All 86 requests still match public OpenAPI. JSON bodies and query representations pass. The public spec and target collection were not changed by the gRPC expansion. |
| Handoff ownership | All 114 REST/RPC operations have one assigned server owner. The four handoffs distinguish transport and client dependencies. |
| Source preservation | Original PDF SHA-256 values and pre-existing Postman files remain unchanged. Application code, deployment configuration and the legacy protobuf remain unchanged. |

Both bundled OpenAPI specs pass Postman syntax lint with zero violations. The 86-request collection passes lint with zero errors/warnings.
The updated container, collaboration and payment-recovery diagrams were rendered to SVG/PNG and visually inspected. Their SVG XML parses.
All 46 Markdown files and 274 local links/anchors pass. The ADR sequence is 0001–0028.
These checks establish contract consistency. They do not establish target runtime, concurrency, provider, UI or deployment acceptance.

## Repeat the checks

Python uses jsonschema 4.26.0 and PyYAML 6.0.3. Offline execution requires those dependencies in the local uv cache.
Protobuf checking reuses Booking's installed proto-loader, protobufjs and grpc-js dependencies. It installs nothing in the repository.

```sh
uv run --offline --with jsonschema==4.26.0 --with pyyaml==6.0.3 python contracts/validate.py --collection 'postman/collections/Tutor Matcher Target Public v1' --bundle-dir /tmp/tutor-matcher-contract-bundle
node contracts/check-proto.cjs
postman spec lint /tmp/tutor-matcher-contract-bundle/public.openapi.json --issueType syntax --no-report-events -o json
postman spec lint /tmp/tutor-matcher-contract-bundle/internal.openapi.json --issueType syntax --no-report-events -o json
postman collection lint 'postman/collections/Tutor Matcher Target Public v1' -r json
```

Postman's external shared-schema resolver failed on the source specs. Lint uses reproducible bundled copies from `validate.py` instead.
The checker verifies source references separately. Bundles are disposable tooling outputs, not another authority.
The target collection's earlier generator corrections and empty runtime-token variable remain intact.
No Postman cloud initialization or publication is part of this work.

## Remaining implementation evidence

Implement both RPC servers and their permitted clients before reporting a method as working.
Execute the [recovery cases](recovery.md), authorization negatives, nine UI journeys and simulated provider failures.
Test actual database transactions/outboxes, scalar validation, metadata allowlists, lost responses, deadline handling and financial reconciliation.
Complete hosted/local deployment, isolated restoration, scalability measurements and final submission evidence.
The presence/normalization example in the contract checker is not an application adapter or a running server.

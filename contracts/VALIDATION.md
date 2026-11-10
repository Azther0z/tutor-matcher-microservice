# Step-3 validation record

Implementation follow-up, 8 November 2026: dependencies are now installed and the protobuf codec check passes in this worktree. The missing-dependency note in the account-lifecycle section below is historical. See the [implementation evidence](../docs/evidence/saint/README.md) for the earlier Auth/TypeScript-Gateway/database/browser/broker checks and their limits. The full 20-RPC target is not deployed.
These contract checks establish schema, inventory and codec consistency. They do not establish the stacked Traefik routes, the private ForwardAuth exchange, or owner-side runtime behavior; see the [Traefik integration evidence](../docs/evidence/saint/traefik-integration.md).

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

## Account lifecycle clarification: 8 November 2026

Recorded the user-confirmed all-session revocation, permanent bans, manually restored suspensions and admin-only restoration of soft-deactivated accounts. The public login contract now declares its existing invalid-credential and restricted-account outcomes as HTTP 401 and 403. Request shapes, operation inventory, protobuf files and the target Postman collection remain unchanged.

The offline contract checker passed all 129 shared definitions, 24 gRPC validation definitions, 21 event variants, 114 operations, 82 schema cases, nine money/time cases, 40 gRPC request/response messages and 12 invalid gRPC cases. All 86 target collection requests still match the public spec. The updated bundled public OpenAPI passed Postman syntax lint with zero violations. The six changed requirements/design/ADR/handoff/glossary/contract-guide files passed 61 local link/anchor checks, and `git diff --check` passed.

The protobuf codec check could not run in this worktree because Booking's `@grpc/proto-loader` dependency is not installed. The earlier codec results above are historical; no new codec or runtime pass is claimed. No dependencies were installed and no application or deployment code changed.

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

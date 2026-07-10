# Review bulk rejection

PawPlan users can clear the Review queue without changing the live schedule. The UI confirms the visible
draft and operation counts, sends only that confirmed patch snapshot, and refreshes the server-rendered
queue after the atomic rejection transaction. Every rejected patch keeps its audit record.

## HTTP contract

```yaml
openapi: 3.1.0
info:
  title: PawPlan Review bulk rejection
  version: 1.0.0
paths:
  /api/patches/reject-all:
    post:
      summary: Reject the confirmed snapshot of Review drafts
      description: >-
        Marks matching draft patches in the authenticated workspace and active plan as rejected,
        persists per-patch review audits, and does not mutate tasks, plans, plan versions, or schedules.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [patchIds]
              additionalProperties: false
              properties:
                patchIds:
                  type: array
                  minItems: 1
                  maxItems: 1000
                  uniqueItems: true
                  items:
                    type: string
                    format: uuid
      responses:
        "200":
          description: Atomic rejection result plus Review queue readback
          content:
            application/json:
              schema:
                type: object
                required:
                  - status
                  - planId
                  - requestedPatchCount
                  - rejectedPatchCount
                  - rejectedOperationCount
                  - rejectedPatchIds
                  - remainingDraftCount
                properties:
                  status:
                    type: string
                    enum: [succeeded, no_change]
                  planId:
                    type: string
                    format: uuid
                  requestedPatchCount:
                    type: integer
                    minimum: 1
                  rejectedPatchCount:
                    type: integer
                    minimum: 0
                  rejectedOperationCount:
                    type: integer
                    minimum: 0
                  rejectedPatchIds:
                    type: array
                    items:
                      type: string
                      format: uuid
                  remainingDraftCount:
                    type: integer
                    minimum: 0
        "400":
          description: Invalid patch snapshot or no active plan
        "401":
          description: Missing workspace session
        "500":
          description: Rejection transaction failed and was rolled back
```

## Reliability boundary

- The transaction first claims matching `draft` rows by changing them to `rejected`, then writes one
  `agent_patch_reviews` record per claimed patch. Any audit failure rolls the transaction back.
- Repeating the same request is idempotent and returns `no_change` when the snapshot is already closed.
- `remainingDraftCount` is queried from persisted state. A draft created concurrently but absent from the
  confirmed snapshot remains visible after refresh instead of being rejected unexpectedly.

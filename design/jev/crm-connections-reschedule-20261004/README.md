# Appointment replacement consultation

Three fresh semantically equivalent requests retain exact current CanBook book/cancel, ScheduleV1 reserve/release declarations and handlers, and RoomsV1 declarations. Full explanatory prose and criteria were rewritten and checked before sending. The first attempt lacked network access and returned no response; elevated calls used the user’s standing authorization. Responses are preserved in full.

| Run | Choice | Confidence | Staged | Disjoint | Coordinator | Current-guarantee NOUL |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | staged | 0.83 | 0.89 | 0.11 | 0.00 | 0.08 |
| 2 | staged | 0.98 | 0.99 | 0.01 | 0.00 | 0.10 |
| 3 | staged | 0.93 | 0.96 | 0.04 | 0.00 | 0.18 |

The chosen alternative agrees across calls; certainty does not. The distributions are advice, not proof or approval thresholds. Source inspection independently shows that reserve_connected updates the previous same-source interval before a room authority can settle. A new unlinked source conflicts with its original overlapping appointment. Staging must preserve the existing compatible-duty exception: the predecessor is the only additional appointment/visit overlap exemption. It must not reject otherwise compatible same-location duty coverage, and must not exempt other appointments or visits.

The agreed staff shape is ScheduleV1.stage(value:CommitmentRequest,previous_source:text,previous_revision:int)->OperationOutcome. A fresh candidate keeps its predecessor allocated; existing release retires candidate or predecessor with retained cancellation tombstones. Room/venue staging is coordinated at the owning capacity authority separately. Cross-provider atomicity is not claimed. Runtime/provider implementations remain unimplemented.

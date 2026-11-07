---
status: accepted
recorded: 2026-11-06
---

# Give private conversations a Messaging service

Messaging is required but absent from the original service map. Give conversations, messages, participants, and read state one Messaging owner with its own MongoDB database.
Keep Review separate as the PDF already specifies. Notification retains preferences and delivery rather than becoming the owner of private conversational content.

The alternative was to put conversations in Notification to reduce the number of services. The user selected separate ownership.
Do not add Admin, Dispute, Meeting, Payout, or Scheduler services to compensate for other missing operations. Their existing owners remain.

See the [system design](../system-design.md#containers-and-data-ownership) and [requirements](../requirements.md). Approval of this design does not mean Messaging is implemented.

Source: user-confirmed step-2 decision, 6 November 2026. The unchanged [PDF](../sources/tutor-matcher.pdf), pp. 22–24, remains the original ownership evidence.

---
status: accepted
recorded: 2026-11-06
---

# Extract the Tutor service

Keep profiles, subject offerings, and catalogue discovery behind an independently deployable Tutor service. Its data belongs to that service. Record the scaling benefit and maintain explicit contracts and recovery procedures.

The original extraction context also mentioned availability. The PDF's later service design assigns availability to Booking, which is the accepted ownership baseline. Further design must preserve one owner for a tutor's bookable time.

Source: [Tutor Matcher PDF](../sources/tutor-matcher.pdf), pp. 14, original ADR-010. Reconciled against the [accepted requirements](../requirements.md) on 6 November 2026.

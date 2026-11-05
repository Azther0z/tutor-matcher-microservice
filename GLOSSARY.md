# Tutor Matcher

Tutor Matcher connects students and tutors through subject discovery, one-to-one bookings, and a shared wallet journey.
The [requirements](docs/requirements.md) define the policies and acceptance criteria for these terms.

## Language

**User**:
One registered account with Student capability and any additional approved Tutor or controlled Admin capabilities.
_Avoid_: Separate student and tutor accounts

**Student**:
The capability that lets a user learn, book lessons, pay, message tutors, and review completed bookings.
_Avoid_: Learner, customer

**Tutor**:
A user approved to publish subjects and teach booked lessons.
_Avoid_: Separate tutor account, teacher account

**Admin**:
A user authorized to review applications, moderate content, handle disputes, and restrict accounts.
_Avoid_: Meeting organizer

**Tutor application**:
A submitted profile version that requests Tutor capability on the same account.
_Avoid_: Tutor registration, second account

**Listing**:
The tutor's approved public profile and its publication state.
_Avoid_: Application, draft

**Subject**:
One tutor's teaching offering with its own description, rate, format, and learning areas.
_Avoid_: Class, course package

**Availability slot**:
A dated half-hour of a tutor's time that advertises one or more owned subjects.
_Avoid_: Weekly schedule, subject-owned slot

**Booking**:
One student's reservation of one tutor's subject for a continuous block of availability slots.
_Avoid_: Group reservation, recurring plan

**Lesson**:
The delivery of a confirmed booking at its scheduled time.
_Avoid_: Separate class entity

**Completed booking**:
A booking whose assigned tutor confirms completion after the scheduled lesson end.
_Avoid_: Paid booking, automatically completed booking

**Wallet**:
The user's single account for top-ups, lesson payments, cleared earnings, refunds, and eligible payouts.
_Avoid_: Lesson credits, separate student and tutor balances

**Available funds**:
Funds that the user can spend after excluding pending earnings and active payout reservations.
_Avoid_: Pending earnings, gross lesson value

**Pending earnings**:
The tutor's expected net lesson earnings that are not yet available to spend or withdraw.
_Avoid_: Available balance, completed wallet movement

**Wallet transaction**:
One completed movement of money in one user's wallet, retained as read-only history.
_Avoid_: Pending payment attempt, editable balance adjustment

**Payout**:
A tutor's withdrawal of available funds to an owned payout account.
_Avoid_: Student withdrawal, lesson payment

**Payment dispute**:
A student's recorded claim about a lesson-related payment that requires an admin decision.
_Avoid_: Automatic refund, payment timeout

**Review**:
A student's rating and text linked to their completed booking's tutor and subject.
_Avoid_: Unverified testimonial, subject-independent tutor comment

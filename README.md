# Tutor Matcher

Tutor Matcher is an online marketplace for one-to-one tutoring. Students can browse a tutor's profile, subjects, rates, and available lesson times. Tutors maintain their public offering and open time slots for future bookings.

This repository implements the Tutor Matcher services behind an API gateway. The demo covers three business use cases plus authentication: UC-03 discover, book and pay for a lesson, UC-04 top up the wallet, and UC-06 cancel a booking with a refund. When a client requests a tutor profile, the Tutor service retrieves that tutor's slots from Booking over gRPC and returns a combined response.

## Architecture

| Service | Interface | Owns | Database |
| --- | --- | --- | --- |
| API gateway | REST on port `8080` | Routing and JWT checks; passes the signed-in user to services | none |
| Auth | REST on port `4002` | Accounts, password hashes, login tokens | PostgreSQL `auth_db` |
| Tutor | REST on port `4001` | Profiles, publication status, subjects, hourly rates, search | MongoDB `tutor_db` |
| Booking | gRPC on port `50052`, REST on port `4004` | Availability slots, bookings, payment and cancellation state | MongoDB `booking_db` |
| Wallet | REST on port `4003` | Balances, mock PromptPay top-ups, payments, refunds | PostgreSQL `wallet_db` |
| Notification | RabbitMQ consumer | Delivery log of notifications | MongoDB `notification_db` |

Each service owns its database and never reads another service's data directly. A slot stores the tutor's ID as a string; Booking does not query the Tutor database. The shared [protobuf contract](proto/booking.proto) defines the gRPC calls between Tutor and Booking.

Booking calls Wallet synchronously to charge a lesson, because a booking is confirmed only after the money is taken. Charges and refunds are keyed by booking ID, so a retried request never moves money twice. Top-ups are confirmed once, even if the payment confirmation arrives again.

Auth, Wallet and Booking publish events to the RabbitMQ topic exchange `tutor-matcher.events`. The Notification service consumes them from the durable queue `notification.events`. If Notification is down, the business action still succeeds and the event waits in the queue. Each event has an `eventId`, and Notification records deliveries with a unique `eventId`, so a redelivered event is not sent twice.

| Event | Published by | When |
| --- | --- | --- |
| `user.registered` | Auth | A new account is created |
| `wallet.topped_up` | Wallet | A top-up payment is confirmed |
| `booking.confirmed` | Booking | A booking is paid |
| `booking.cancelled` | Booking | A booking is cancelled, with the refund amount |

PromptPay is mocked: `POST /wallet/topups` returns a placeholder payload instead of a real QR code, and `POST /wallet/topups/:id/confirm` stands in for the payment provider's confirmation.

## Run everything with Docker

```bash
docker compose up -d --build
docker compose logs -f notification-service
```

This starts MongoDB, PostgreSQL, RabbitMQ and all services. Send requests to the gateway at `http://127.0.0.1:8080`. The RabbitMQ management UI is at `http://127.0.0.1:15672` (`guest` / `guest`). To browse the data, open Adminer at `http://127.0.0.1:8081` (System PostgreSQL, server `postgres`, user `tutor`, password `tutor`, database `auth_db` or `wallet_db`), and connect MongoDB Compass to `mongodb://127.0.0.1:27018`.

To use MongoDB Atlas instead of the local MongoDB, copy `.env.example` to `.env` in the repository root and set `MONGO_URI` to your Atlas URI (add your IP to the Atlas access list first). Tutor, Booking and Notification then use `tutor_db`, `booking_db` and `notification_db` on Atlas, which you can browse in Atlas under **Data Explorer**. Stop with `docker compose down`, or `docker compose down -v` to also delete the data.

### Demo flow

Import [the D4 demo collection](postman/d4-demo.postman_collection.json) and run the requests in order. **Get wallet** first returns 401. After **Login**, paste the token into the collection's Authorization tab (Bearer Token), save, and send **Get wallet** again. The rest tops up 500 THB, books a one-hour lesson for 400 THB, pays from the wallet, then cancels for a refund. Watch the Notification logs while it runs.

| Method | Gateway path | Login | Description |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | no | Create an account and get a token |
| `POST` | `/auth/login` | no | Get a token |
| `GET` | `/auth/me` | yes | Current account |
| `GET` | `/tutors?subject=&q=&maxRate=` | no | Search published tutors |
| `GET` | `/tutors/:id` | no | Tutor profile with availability |
| `POST` | `/availability` | yes | Open a 30-minute slot for a tutor |
| `POST` | `/wallet/topups` | yes | Start a mock PromptPay top-up |
| `POST` | `/wallet/topups/:id/confirm` | yes | Simulate the payment confirmation |
| `GET` | `/wallet` | yes | Balance and recent transactions |
| `POST` | `/bookings` | yes | Hold back-to-back slots; price is slots × hourly rate ÷ 2 |
| `POST` | `/bookings/:id/pay` | yes | Pay from the wallet and confirm |
| `POST` | `/bookings/:id/cancel` | yes | Cancel; full refund 24 hours or more before the start, otherwise half |
| `GET` | `/bookings` | yes | Your bookings |

The sections below describe running Tutor and Booking alone against MongoDB Atlas.

## Requirements

- Node.js and npm
- A MongoDB Atlas cluster, database user, and connection URI
- A gRPC client such as Postman for calling Booking directly

In Atlas, add your current IP address to the project's IP access list, create a database user with access to both databases, and copy the **Drivers** connection string. Replace the username and password in the URI. Percent-encode reserved characters in the password, such as `@` as `%40`.

Copy each service's `.env.example` to `.env`, then paste the **same full Atlas URI** after `MONGO_URI=` in both files. For example:

```dotenv
MONGO_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER_HOST/?retryWrites=true&w=majority
```

The application selects `tutor_db` and `booking_db` separately, so you do not need to add a database name to the URI. Keep the real URI in `.env`; these files are ignored by Git.

## Run locally

Start Booking first, then Tutor, in separate terminals:

```bash
cd booking-service
npm install
npm run dev
```

```bash
cd tutor-service
npm install
npm run dev
```

`MONGO_URI` is required for both services. The other values in `.env.example` can stay as provided. Startup logs show the selected database name after a successful connection.

| Variable | Service | Default |
| --- | --- | --- |
| `PORT` | Tutor | `4001` |
| `MONGO_URI` | Tutor | Your Atlas URI (required); connects to `tutor_db` |
| `BOOKING_GRPC_URL` | Tutor | `127.0.0.1:50052` |
| `GRPC_PORT` | Booking | `50052` |
| `MONGO_URI` | Booking | The same Atlas URI (required); connects to `booking_db` |

## API

### Tutor REST API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/tutors` | Create a tutor profile |
| `GET` | `/tutors/:id` | Get a profile with availability from Booking |
| `PUT` | `/tutors/:id` | Update a profile |
| `DELETE` | `/tutors/:id` | Delete a profile |

A tutor has `firstName`, `lastName`, `email`, optional profile media and biography, a publication `status`, and embedded `subjects` with names, descriptions, and hourly rates. The status is one of `PENDING`, `UNPUBLISHED`, `PUBLISHED`, or `REJECTED`.

`GET /tutors/:id` calls Booking with a two-second deadline. If Booking is unavailable or the call times out, Tutor still returns the profile with `availability: []` and `availabilityUnavailable: true`. A successful call returns `availabilityUnavailable: false`.

### Booking gRPC API

| Method | Description |
| --- | --- |
| `CreateSlot` | Add a dated slot for a tutor |
| `GetAvailability` | List a tutor's slots in start-time order |
| `UpdateSlot` | Change a slot's start time or booking reference |
| `DeleteSlot` | Remove a slot |

Slot timestamps are ISO 8601 strings. `UpdateSlot` accepts an empty `bookingId` to clear the reference. Deleting a tutor does not remove their Booking slots automatically.

## Try the workflow in Postman

Import the [REST collection](postman/tutor-matcher.postman_collection.json). For Booking, create a gRPC request to `127.0.0.1:50052`, import [`booking.proto`](proto/booking.proto), and choose a method from `booking.BookingService`. Use JSON messages with camelCase field names.

1. Send **Create tutor** in the REST collection. It saves the returned `_id` as the collection variable `tutorId`.
2. Call `CreateSlot` with `{"tutorId":"<tutorId>","startedAt":"2026-10-05T09:00:00.000Z"}`. Create another slot at a different time.
3. Send **Get tutor with availability** and confirm both slots appear in `availability`.
4. Call `UpdateSlot` with `{"id":"<slotId>","startedAt":"2026-10-05T11:00:00.000Z"}` or `DeleteSlot` with `{"id":"<slotId>"}`, then fetch the tutor again.
5. Stop Booking and fetch the tutor once more to see the profile response with `availabilityUnavailable: true`.
6. Restart Booking before using the REST update and delete requests.

The REST collection contains the HTTP requests. Postman's gRPC requests use the shared protobuf contract.

# Tutor Matcher

Tutor Matcher is an online marketplace for one-to-one tutoring. Students can browse a tutor's profile, subjects, rates, and available lesson times. Tutors maintain their public offering and open time slots for future bookings.

This repository implements the Tutor and Booking service boundary. The Tutor service owns tutor profiles and subject offerings. The Booking service owns availability slots. When a client requests a tutor profile, the Tutor service retrieves that tutor's slots from Booking over gRPC and returns a combined response.

## Architecture

| Service | Interface | Owns | MongoDB database |
| --- | --- | --- | --- |
| Tutor | REST on port `4001` | Profiles, publication status, subjects, hourly rates | `tutor_db` |
| Booking | gRPC on port `50052` | Availability slots and their booking references | `booking_db` |

Both services use the same MongoDB Atlas cluster and connection URI, but each selects its own database with Mongoose's `dbName` option. A slot stores the tutor's ID as a string; Booking does not query the Tutor database. The shared [protobuf contract](proto/booking.proto) defines the calls between services.

The wider Tutor Matcher architecture also includes payments, reviews, and notifications. Those capabilities are outside this repository's current API. In particular, `bookingId` is a reference on a slot; payment and booking lifecycle operations are not implemented here.

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

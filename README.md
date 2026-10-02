# Tutor Matcher

Tutor Matcher is an online marketplace for one-to-one tutoring. Students can browse a tutor's profile, subjects, rates, and available lesson times. Tutors maintain their public offering and open time slots for future bookings.

This repository implements the Tutor and Booking service boundary. The Tutor service owns tutor profiles and subject offerings. The Booking service owns availability slots. When a client requests a tutor profile, the Tutor service retrieves that tutor's slots from Booking over gRPC and returns a combined response.

## Architecture

| Service | Interface | Owns | MongoDB database |
| --- | --- | --- | --- |
| Tutor | REST on port `4001` | Profiles, publication status, subjects, hourly rates | `tutor_db` |
| Booking | gRPC on port `50052` | Availability slots and their booking references | `booking_db` |

Both services can use one MongoDB instance, but each connects to its own database. A slot stores the tutor's ID as a string; Booking does not query the Tutor database. The shared [protobuf contract](proto/booking.proto) defines the calls between services.

The wider Tutor Matcher architecture also includes payments, reviews, and notifications. Those capabilities are outside this repository's current API. In particular, `bookingId` is a reference on a slot; payment and booking lifecycle operations are not implemented here.

## Requirements

- Node.js and npm
- MongoDB available locally or through MongoDB Atlas
- A gRPC client such as Postman for calling Booking directly

For a local MongoDB container:

```bash
docker run -d --name tutor-matcher-mongo -p 27017:27017 mongo:8
```

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

Each service has an `.env.example` file. The defaults work with MongoDB at `mongodb://127.0.0.1:27017`. Copy the relevant example to `.env` to change a port, connection string, or Booking's gRPC address. Keep `tutor_db` and `booking_db` as separate database names in their respective `MONGO_URI` values.

| Variable | Service | Default |
| --- | --- | --- |
| `PORT` | Tutor | `4001` |
| `MONGO_URI` | Tutor | `mongodb://127.0.0.1:27017/tutor_db` |
| `BOOKING_GRPC_URL` | Tutor | `127.0.0.1:50052` |
| `GRPC_PORT` | Booking | `50052` |
| `MONGO_URI` | Booking | `mongodb://127.0.0.1:27017/booking_db` |

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

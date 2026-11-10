# Review migration

Run `npm run migrate -w @tutor-matcher/review-service` with the owned `MONGO_URI` before starting traffic.
The idempotent migration creates unique review/booking, flag/reporter and operation/event identities and query indexes.
Startup performs the same check. MongoDB must be a replica set or mongos. The service owns only `review_db`.
It does not modify Tutor, Booking, Auth or Notification data. No destructive reset runs at startup.

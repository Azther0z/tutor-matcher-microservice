import { Suspense } from "react";
import { NewBookingPage } from "@/features/booking/bookings";
export default function Page() { return <Suspense fallback={<p role="status">Loading booking…</p>}><NewBookingPage/></Suspense>; }

import { Suspense } from "react";
import { RequireCapability } from "@/features/wallet/common";
import { DisputesPage } from "@/features/wallet/disputes";

export default function Page() {
  return <RequireCapability capability="STUDENT"><Suspense fallback={<p role="status">Loading…</p>}><DisputesPage /></Suspense></RequireCapability>;
}

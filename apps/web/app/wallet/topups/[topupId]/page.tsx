import { Suspense } from "react";
import { RequireCapability } from "@/features/wallet/common";
import { TopupPage } from "@/features/wallet/topup";

export const metadata = { title: "Top-up" };

export default function Page({ params }: { params: Promise<{ topupId: string }> }) {
  return <RequireCapability capability="STUDENT"><Suspense fallback={<p role="status">Loading…</p>}><TopupPage params={params} /></Suspense></RequireCapability>;
}

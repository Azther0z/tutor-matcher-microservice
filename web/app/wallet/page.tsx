import { Suspense } from "react";
import { RequireCapability } from "@/features/wallet/common";
import { WalletOverviewPage } from "@/features/wallet/overview";

export default function WalletPage() {
  return <RequireCapability capability="STUDENT"><Suspense fallback={<p role="status">Loading your wallet…</p>}><WalletOverviewPage /></Suspense></RequireCapability>;
}

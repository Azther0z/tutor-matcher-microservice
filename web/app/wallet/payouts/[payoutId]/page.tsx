import { RequireCapability } from "@/features/wallet/common";
import { PayoutDetailPage } from "@/features/wallet/payouts";

export default function Page({ params }: { params: Promise<{ payoutId: string }> }) {
  return <RequireCapability capability="TUTOR"><PayoutDetailPage params={params} /></RequireCapability>;
}

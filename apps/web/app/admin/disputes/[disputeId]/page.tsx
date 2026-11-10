import { RequireCapability } from "@/features/wallet/common";
import { AdminDisputeDetailPage } from "@/features/wallet/disputes";

export default function Page({ params }: { params: Promise<{ disputeId: string }> }) {
  return <RequireCapability capability="ADMIN"><AdminDisputeDetailPage params={params} /></RequireCapability>;
}

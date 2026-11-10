import { RequireCapability } from "@/features/wallet/common";
import { AdminDisputesPage } from "@/features/wallet/disputes";

export default function Page() {
  return <RequireCapability capability="ADMIN"><AdminDisputesPage /></RequireCapability>;
}

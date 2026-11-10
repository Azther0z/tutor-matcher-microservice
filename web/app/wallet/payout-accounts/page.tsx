import { RequireCapability } from "@/features/wallet/common";
import { PayoutAccountsPage } from "@/features/wallet/payout-accounts";

export default function Page() {
  return <RequireCapability capability="TUTOR"><PayoutAccountsPage /></RequireCapability>;
}

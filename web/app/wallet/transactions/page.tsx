import { RequireCapability } from "@/features/wallet/common";
import { TransactionsPage } from "@/features/wallet/transactions";

export default function Page() {
  return <RequireCapability capability="STUDENT"><TransactionsPage /></RequireCapability>;
}

import { RequireCapability } from "@/features/wallet/common";
import { TransactionsPage } from "@/features/wallet/transactions";

export const metadata = { title: "Transaction history" };

export default function Page() {
  return <RequireCapability capability="STUDENT"><TransactionsPage /></RequireCapability>;
}

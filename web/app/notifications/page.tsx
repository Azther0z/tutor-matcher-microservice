import { RequireCapability } from "@/features/wallet/common";
import { NotificationsPage } from "@/features/notification/notifications";

export default function Page() {
  return <RequireCapability capability="STUDENT"><NotificationsPage /></RequireCapability>;
}

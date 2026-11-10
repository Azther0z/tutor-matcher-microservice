"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/lib/auth-context";
import { Notice } from "@/components/field";
import { Dropdown } from "@/components/dropdown";
import { Avatar } from "@/components/avatar";
import { Pager, StatusBadge } from "@/features/wallet/common";
import { api, errorMessage } from "@/lib/api";
import type { AccountPage as AccountPageType } from "@/lib/types";

const CAPABILITIES = [
  { value: "", label: "Any capability" },
  { value: "STUDENT", label: "Student" },
  { value: "TUTOR", label: "Tutor" },
  { value: "ADMIN", label: "Admin" },
];

function UserSearch() {
  const [q, setQ] = useState("");
  const [capability, setCapability] = useState("");
  const [result, setResult] = useState<AccountPageType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (page: number) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (q.trim()) params.set("q", q.trim());
    if (capability) params.set("capability", capability);
    try {
      setResult(await api<AccountPageType>(`/admin/users?${params}`));
    } catch (caught) {
      setError(errorMessage(caught, "Could not load accounts."));
    } finally {
      setLoading(false);
    }
  }, [q, capability]);

  // Search as you type, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => void load(1), 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <header className="page-heading page-heading-row">
        <h1>Accounts</h1>
        <div className="admin-toolbar">
          <input
            className="search-input admin-search"
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search name or email"
            aria-label="Search by name or email"
          />
          <div className="tx-filter">
            <Dropdown id="capability" value={capability} onValueChange={setCapability} options={CAPABILITIES} />
          </div>
        </div>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      {loading && !result && <p role="status" className="tutor-card-meta">Loading accounts…</p>}
      {result && result.items.length === 0 && <p className="tutor-card-meta">No accounts match this search.</p>}
      {result && result.items.length > 0 && (
        <div className="tx-list" aria-busy={loading}>
          {result.items.map((item) => (
            <Link key={item.id} className="panel tutor-card tx-card" href={`/admin/users/${encodeURIComponent(item.id)}`}>
              <span className="message-who">
                <Avatar name={`${item.firstName} ${item.lastName}`} size={40} />
                <span>
                  <strong>{item.firstName} {item.lastName}</strong>
                  <small>{item.email}</small>
                </span>
              </span>
              <span className="wallet-tx-amount">
                <StatusBadge value={item.status} />
                <small>{item.capabilities.map((value) => value.charAt(0) + value.slice(1).toLowerCase()).join(", ")}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
      {result && <Pager meta={result.pagination} onPage={(page) => void load(page)} disabled={loading} />}
    </>
  );
}

export default function AdminUsersPage() {
  return <RequireAuth admin><UserSearch /></RequireAuth>;
}
